/**
 * HUD - Subagent (teammate) token accumulation
 *
 * The lead session transcript that Claude Code hands the statusline no longer
 * contains subagent activity. Since the teammate rework, each subagent writes
 * its OWN transcript into a tree next to the lead one, in two known layouts:
 *
 *   <lead>/subagents/agent-<name>-<hash>.jsonl           ← Agent-tool teammates
 *   <lead>/subagents/workflows/wf_<id>/agent-<id>.jsonl  ← Workflow-tool agents
 *
 * (each with a sibling `.meta.json`), sharing the parent `sessionId`. That
 * nesting is why the walk below recurses instead of a flat readdir: a Workflow
 * run puts every one of its agents a level deeper, and a flat listing sees only
 * the `workflows` directory — which fails the `agent-` prefix test, so an entire
 * run reads as "no teammates" and scores 0. Since a Workflow is typically where
 * the bulk of a session's tokens go, that hid the majority of real usage.
 *
 * These files carry full per-turn token usage the lead transcript never sees,
 * so `token:` would otherwise undercount every multi-agent run. The lead holds
 * no `isSidechain` turns of its own, so folding them in is purely additive
 * ACROSS the lead/subagent boundary — measured over 56 sessions with teammates,
 * no `message.id` is shared between a lead and its own `subagents/`, nor
 * between sibling subagent files, so nothing is counted twice between them.
 *
 * WITHIN a single file, however, rows very much do repeat: Claude Code writes
 * one row per content block of an assistant response, each carrying that call's
 * usage. Summing rows counted one call 2-4x. Both the lead and every file here
 * therefore route through `tallyFile` (token-tally.js), which de-duplicates on
 * `message.id` and scans forward incrementally, so the two sides stay accounted
 * for identically by construction rather than by comment.
 *
 * Because the HUD renders one Node process per frame, an in-memory cache would
 * never survive between frames — so per-file tallies are memoized on disk in the
 * session cache dir under each file's path relative to the subagents dir. A
 * size+mtime stamp short-circuits unchanged files to zero I/O; a file that grew
 * is resumed at its saved byte offset, so only the appended bytes are parsed.
 * Any error yields 0: the HUD must never break on a subagent read.
 */
import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { basename, dirname, join, relative } from "path";
import { sessionCacheFile } from "../lib/worktree-paths.js";
import { tallyFile } from "./token-tally.js";
import { atomicWriteJsonSync } from "../lib/atomic-write.js";
// Bound the descent. The known layouts put agent files at depth 0 (Agent-tool
// teammates) and depth 2 (workflows/wf_<id>/); the headroom covers further
// nesting without letting a pathological tree stall a render.
const MAX_WALK_DEPTH = 4;
// Backstop for pathological teams, not a budget. The old cap of 64 truncated
// real work — the exact undercount this module exists to prevent — because a
// single Workflow run nests dozens of agents under one session. There is no true
// ceiling to size against (a session can run several workflows), so this sits far
// above any team seen in practice and degrades honestly if it ever does bite: we
// prefer larger files and say so under HUD_DEBUG, so a capped sum never reads as
// "counted everything".
const MAX_SUBAGENT_FILES = 512;
/**
 * Derive the subagents directory for a lead transcript path, or null when the
 * path is not a `.jsonl` transcript.
 *
 *   <dir>/<uuid>.jsonl  ->  <dir>/<uuid>/subagents
 */
export function getSubagentsDir(leadTranscriptPath) {
    if (!leadTranscriptPath || !leadTranscriptPath.endsWith(".jsonl")) {
        return null;
    }
    return join(dirname(leadTranscriptPath), basename(leadTranscriptPath, ".jsonl"), "subagents");
}
/**
 * Recursively collect every teammate transcript under the subagents dir, with
 * the stat data the memo key needs. Recursion is hand-rolled because
 * `readdirSync`'s `recursive` option lands in Node 18.17 and this project
 * supports Node >= 14.17. Descent follows `isDirectory()`, which is false for a
 * symlink, so a symlinked cycle cannot trap the walk; unreadable directories
 * are skipped rather than fatal.
 */
function collectAgentFiles(root, dir = root, depth = 0, out = []) {
    if (depth > MAX_WALK_DEPTH) {
        return out;
    }
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            collectAgentFiles(root, full, depth + 1, out);
            continue;
        }
        if (!entry.name.startsWith("agent-") || !entry.name.endsWith(".jsonl")) {
            continue;
        }
        let stat;
        try {
            stat = statSync(full);
        }
        catch {
            continue;
        }
        out.push({
            path: full,
            rel: relative(root, full),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
        });
    }
    return out;
}
/**
 * Sum de-duplicated input+output tokens across every teammate transcript under
 * this lead session, memoized per file on disk. Returns 0 when there are no
 * teammates or on any error (never throws).
 */
export function sumSubagentTokens(leadTranscriptPath, sessionKey) {
    try {
        const dir = getSubagentsDir(leadTranscriptPath);
        if (!dir || !existsSync(dir)) {
            return 0;
        }
        const found = collectAgentFiles(dir);
        if (found.length === 0) {
            return 0;
        }
        let files = found;
        if (found.length > MAX_SUBAGENT_FILES) {
            // Prefer larger files. Size is only a rough proxy for token count —
            // cache read/creation tokens bloat bytes without counting toward the
            // input+output sum — but it beats an arbitrary readdir slice.
            files = found
                .slice()
                .sort((a, b) => b.size - a.size)
                .slice(0, MAX_SUBAGENT_FILES);
            if (process.env.HUD_DEBUG) {
                console.error(`[HUD] subagent token sum: ${found.length} teammate files, summing the ${MAX_SUBAGENT_FILES} largest`);
            }
        }
        // Per-file memo, keyed by path relative to the subagents dir → a
        // tallyFile memo plus a "size:mtime" stamp. Survives the
        // one-process-per-render model by living in the session cache dir. Stale
        // entries for removed files are dropped by rebuilding the map from the
        // current listing.
        const cachePath = sessionKey ? sessionCacheFile("subagent-tokens", sessionKey) : null;
        let cache = {};
        if (cachePath) {
            try {
                cache = JSON.parse(readFileSync(cachePath, "utf8")) || {};
            }
            catch {
                cache = {};
            }
        }
        const next = {};
        let total = 0;
        let changed = false;
        for (const file of files) {
            const stamp = `${file.size}:${Math.round(file.mtimeMs)}`;
            const hit = cache[file.rel];
            // Fast path: the file has not been touched since we last tallied it,
            // so reuse the memo without opening it at all. This is what keeps a
            // 500-file team at one stat() each per frame.
            //
            // `hit.consumed === file.size` is the load-bearing half. `tallyFile`
            // reports failure by returning a memo that did NOT reach the end of
            // the file, and a stamp alone cannot tell that apart from success —
            // so without this check one unreadable frame (ENOENT on a rotated
            // file, EACCES, EMFILE) would be stamped as authoritative and, since
            // a finished transcript never changes size or mtime again, freeze
            // that teammate at a wrong total (usually 0) for the whole session.
            // Requiring full coverage makes a failed tally retry next frame.
            // Costs nothing in practice: every one of the 509 real transcripts
            // on this machine ends with a newline, so `consumed === size` holds
            // and the fast path still fires everywhere.
            if (hit &&
                hit.stamp === stamp &&
                typeof hit.total === "number" &&
                hit.consumed === file.size) {
                next[file.rel] = hit;
                total += hit.total;
                continue;
            }
            // Changed (or unseen): resume the tally at the memo's byte offset so
            // only the appended bytes are parsed. Entries written by the older
            // `{ key, tokens }` format carry no `fp`, so tallyFile rescans them
            // from 0 — a one-frame cost, then they migrate to the new shape.
            const memo = tallyFile(file.path, file.size, hit);
            next[file.rel] = { ...memo, stamp };
            total += memo.total;
            changed = true;
        }
        // Persist when a file changed or the set of teammates changed (prune).
        if (cachePath &&
            (changed || Object.keys(next).length !== Object.keys(cache).length)) {
            try {
                atomicWriteJsonSync(cachePath, next);
            }
            catch {
                // Best-effort; a missed write just re-reads next frame.
            }
        }
        return total;
    }
    catch (error) {
        if (process.env.HUD_DEBUG) {
            console.error("[HUD] subagent token sum error:", error instanceof Error ? error.message : error);
        }
        return 0;
    }
}
