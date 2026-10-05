/**
 * Cross-render memo for a working-tree status walk — `svn status` and
 * `git status`, which both read the whole tree and so are the one part of a
 * frame whose cost grows with the checkout.
 *
 * The memo lives on disk (`cache/<session>/<name>.json`) because the HUD runs
 * one process per render: an in-memory cache is gone by the next frame, so
 * without this every frame would re-walk. Same reason `subagents.js` memoizes
 * its tallies. It holds one entry — a session works in one directory — and a
 * different `cwd` simply reads as a miss.
 *
 * Record: `{ cwd, counts, stamp, at, ms, failedAt? }` — the counts, the change
 * stamp read after the walk, when it was written, how long the walk took
 * (the timeout, for one that timed out), and when a walk last failed.
 *
 * Policy, in order:
 *
 * 1. **Serve a fresh memo.** Two invalidation triggers, ORed because each
 *    covers what the other misses: `stamp` (the caller's cheap proxy for
 *    "the schedule changed" — svn's `wc.db`, git's index) catches a staging
 *    change on the very next frame, and the `MEMO_TTL_MS` clock catches plain
 *    working-file edits, which touch no metadata. A walk of a second or more
 *    also holds off the next one for `WALK_DUTY_FACTOR` times its length,
 *    stamp or not, so a slow tree cannot spend more than about a tenth of the
 *    time walking — a background render holds the render lock while it walks,
 *    and the line stands still meanwhile.
 * 2. **A synchronous render** (Claude Code is waiting) serves whatever the
 *    memo holds, at any age. With no memo it walks only when the caller says
 *    the walk is cheap enough to try (`syncScan`, git), and then only with the
 *    short timeout.
 * 3. **A failed walk backs off** for `FAILURE_BACKOFF_MS`, serving the last
 *    good counts. Without it a tree whose walk outlasts the timeout never gets
 *    a memo written, so every frame pays the full timeout and fails again — a
 *    28 s `svn status` on a Windows checkout put ~3 s into every render.
 * 4. **Otherwise walk.** The first walk gets the short timeout. A tree already
 *    known (a memo exists) gets `longTimeoutMs`: a background render waits on
 *    nothing, and with only the short one a tree slower than it never showed
 *    counts at all. A long walk is pre-recorded as a failure before it starts,
 *    so a render killed mid-walk still starts the backoff instead of letting
 *    the next render walk again. A short walk that times out is recorded
 *    without `failedAt`, so the next background render retries at once with
 *    the long timeout.
 *
 * `memoMinMs` keeps a fast tree live: a walk quicker than it is neither served
 * from the memo nor written (git uses 300 ms, so a small repo still shows an
 * edit on the next frame; svn uses 0 and memoizes every walk). A fast walk
 * after a slow one is written once, to supersede it.
 */
import { readFileSync } from 'fs';
import { sessionCacheFile } from './worktree-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';
/** How long a memoized status stays authoritative before a rescan. */
export const MEMO_TTL_MS = 30_000;
/** How long a failed walk suppresses the next one. */
export const FAILURE_BACKOFF_MS = 5 * 60_000;
/** A walk at least this long spaces the next one out (see WALK_DUTY_FACTOR). */
const SLOW_WALK_MS = 1000;
/** A slow walk is not repeated for this many times its own length. */
const WALK_DUTY_FACTOR = 10;
function readMemo(file, cwdKey) {
    if (!file) {
        return null;
    }
    try {
        const memo = JSON.parse(readFileSync(file, 'utf-8'));
        if (!memo || memo.cwd !== cwdKey || typeof memo.at !== 'number') {
            return null;
        }
        // A record from before `stamp`/`ms` existed (svn's `wcDb` memo) compares
        // unequal to any real stamp, so it costs one rescan and then self-heals.
        return memo;
    }
    catch {
        // No memo yet, or it is unreadable/torn — treat as a cold start.
        return null;
    }
}
function writeMemo(file, record) {
    if (!file) {
        return;
    }
    try {
        // Durable: the record can be a failed walk's backoff (`failedAt`), and
        // a crash that rolled it back would let a slow tree walk again with the
        // long timeout. Written only around a walk, so the fsyncs are rare.
        atomicWriteJsonSync(file, record, { durable: true });
    }
    catch {
        // Best-effort: a missed memo only costs the next frame a rescan.
    }
}
/**
 * Status counts for `cwdKey`, from the memo or a fresh walk.
 *
 * @param opts.name - Memo file base name (`git-status`, `svn-status`)
 * @param opts.sessionKey - Session key naming the cache folder (no memo without it)
 * @param opts.cwdKey - Absolute directory the counts describe
 * @param opts.readStamp - () => string|null, the change stamp (never throws)
 * @param opts.scan - (timeoutMs) => counts; throws on failure or timeout
 * @param opts.syncRender - A synchronous render: serve the memo, see policy 2
 * @param opts.syncScan - Walk under syncRender when there is no memo
 * @param opts.memoMinMs - Walks faster than this stay live (see header)
 * @param opts.shortTimeoutMs - Timeout for a first or synchronous walk
 * @param opts.longTimeoutMs - Timeout for a background walk of a known tree
 * @returns Counts, or null with nothing measured yet
 */
export function memoizedStatus(opts) {
    const { name, sessionKey, cwdKey, readStamp, scan, syncRender, syncScan, memoMinMs, shortTimeoutMs, longTimeoutMs, } = opts;
    const file = sessionKey ? sessionCacheFile(name, sessionKey) : null;
    const raw = readMemo(file, cwdKey);
    // The record the policy acts on: a fast walk's record exists only to
    // supersede a slow one, and is otherwise ignored.
    const memo = raw && (typeof raw.failedAt === 'number' || (raw.ms ?? 0) >= memoMinMs) ? raw : null;
    const now = Date.now();
    if (memo && memo.counts) {
        const age = now - memo.at;
        const holdOff = (memo.ms ?? 0) >= SLOW_WALK_MS ? memo.ms * WALK_DUTY_FACTOR : 0;
        if (age < holdOff || (age < MEMO_TTL_MS && memo.stamp === readStamp())) {
            return memo.counts;
        }
    }
    if (syncRender && (memo || !syncScan)) {
        return memo ? memo.counts : null;
    }
    if (memo && now - (memo.failedAt ?? 0) < FAILURE_BACKOFF_MS) {
        return memo.counts;
    }
    const long = Boolean(memo) && !syncRender;
    const timeoutMs = long ? longTimeoutMs : shortTimeoutMs;
    const previous = {
        cwd: cwdKey,
        counts: memo ? memo.counts : null,
        stamp: memo ? memo.stamp ?? null : null,
        at: memo ? memo.at : 0,
        ms: memo ? memo.ms ?? 0 : 0,
    };
    if (long) {
        writeMemo(file, { ...previous, failedAt: now });
    }
    const started = Date.now();
    try {
        const counts = scan(timeoutMs);
        const ms = Date.now() - started;
        if (ms >= memoMinMs || memo) {
            // Stamped *after* the walk, not before: should the walk itself ever
            // move the stamp, storing the pre-walk value would make every
            // frame re-trigger a rescan.
            writeMemo(file, { cwd: cwdKey, counts, stamp: readStamp(), at: Date.now(), ms });
        }
        return counts;
    }
    catch {
        // Keep the last good counts — and their `at`/`stamp`, so the memo
        // still reads as stale. A long walk starts the backoff (its record is
        // already written); a short one records only that the tree is slow.
        // A quick failure under `memoMinMs` (git: not a repository after all)
        // writes nothing, as a quick success would not.
        const ms = Date.now() - started;
        if (!long && ms >= memoMinMs) {
            writeMemo(file, { ...previous, ms: Math.max(previous.ms, ms) });
        }
        return previous.counts;
    }
}
