/**
 * HUD - Incremental, de-duplicated token tally
 *
 * Single source of truth for the cumulative `token:` figure, for both the lead
 * transcript and every teammate/subagent transcript. It exists because the
 * naive "sum `input_tokens + output_tokens` over every JSONL row" approach was
 * wrong twice over:
 *
 * 1. **One API call writes several rows.** Claude Code emits one row per
 *    *content block* of an assistant response — `thinking`, `text`, and each
 *    `tool_use` get their own row — all sharing one `message.id` and one
 *    `requestId`, each carrying that single call's usage. Summing rows
 *    therefore counted one call 2-4x. Measured on a real ultracode session:
 *    261 lead rows for 117 actual calls, inflating the lead's tokens 2.35x
 *    (379,393 → 161,157); across lead + 126 subagents, 2,825,110 displayed
 *    against a true 2,484,323 (+13.7%). We de-duplicate on `message.id`.
 *
 *    **Last row wins, and the reason matters.** The rows of a group are NOT
 *    identical — 10,178 of 35,751 groups across 509 real transcripts carry
 *    differing per-row totals, because early rows can hold a placeholder and
 *    only the last carries the settled value (a real group reads
 *    `output_tokens` 3, 3, 6205). What holds is that the values are
 *    **monotonically non-decreasing**: 0 decreasing steps in those same 35,751
 *    groups. So last-wins and max-wins agree, and first-wins or any-row-wins
 *    would be badly wrong. Do not "simplify" this to counting a group once.
 *
 * 2. **Tail-reading silently truncated the total.** The old path read only the
 *    last 4 MiB of a large transcript and still published the result as a
 *    complete session total. On a 25.4 MB transcript it reported 739,480
 *    against a true 1,910,334 — **39% of the truth** — and because the window
 *    is a fixed number of *bytes*, one big `tool_result` could evict usage rows
 *    and make the counter run backwards. A full scan is correct but costs
 *    ~260 ms on that file — far too slow for a per-frame render — so this
 *    module scans forward incrementally instead: transcripts are append-only,
 *    so each frame parses only the bytes added since the last one and adds them
 *    to a memoized running total.
 *
 * Two properties of the on-disk format make the incremental design safe:
 *   - rows sharing a `message.id` are **contiguous** among usage rows (0
 *     exceptions in 73,748 rows across 509 transcripts), so only the *last*
 *     group can straddle a chunk boundary — carrying `lastId`/`lastIdTokens` in
 *     the memo is enough to correct it. Note this fails *silently* if ever
 *     violated: an id recurring after a gap counts high, a boundary collision
 *     counts low, and nothing asserts either way.
 *   - a `message.id` never appears in two files that are **summed together** —
 *     0 shared ids between a lead and its own `subagents/`, and 0 between
 *     sibling subagent files, across 56 sessions with teammates. (Ids *are*
 *     shared more widely than that — 30 appear in up to 5 files — but only via
 *     forked sessions, which copy rows into a separate lead that is never added
 *     to its parent. The narrow property is the one this relies on.)
 *
 * `fp` + `isLineBoundary` guard resumption against the memo no longer matching
 * the bytes at that offset — a different file reusing the memo slot, or any
 * rewrite that shifts content. Note compaction is NOT such a case: it *appends*
 * `compactMetadata` rows to the same growing file, so it resumes normally.
 *
 * The same forward scan also carries the **tool/agent/skill call counts** and
 * the **session start** (the first row's timestamp), for the same reason: they
 * used to come from the 4 MiB tail read of the lead transcript and were
 * therefore truncated on any larger session — measured on a 4.9 MB transcript:
 * 442 of 494 tool calls and 2 of 3 agent calls — and, like the old token
 * total, could run backwards as the window slid. Every row is already parsed
 * here, so counting them costs nothing, and the memo makes the figures exact
 * at any size. A memo written before these fields existed is not resumable: it
 * triggers one full rescan, then carries them from there.
 *
 * Everything here fails to a null/zero total rather than throwing: the HUD must
 * never break on a transcript read.
 */
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync, } from "fs";
import { sessionCacheFile } from "../lib/worktree-paths.js";
import { atomicWriteJsonSync } from "../lib/atomic-write.js";
// Bytes of the file head that the rewrite fingerprint covers. A transcript's
// first row carries its session id and start timestamp, so a rewrite that keeps
// the first 512 bytes byte-identical is not a rewrite we need to distinguish.
const FINGERPRINT_BYTES = 512;
/** tool_use names counted as an agent invocation (the `A` count). */
const AGENT_TOOLS = new Set(["Task", "proxy_Task", "Agent"]);
/** tool_use names counted as a skill invocation (the `S` count). */
const SKILL_TOOLS = new Set(["Skill", "proxy_Skill"]);
/**
 * FNV-1a over a buffer, returned as hex. Not cryptographic — this only has to
 * notice that a file's head changed, and it keeps the memo small (8 chars)
 * compared with storing the head verbatim.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function fnv1a(buffer) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < buffer.length; i++) {
        hash ^= buffer[i];
        // 32-bit FNV prime multiply via shifts; `>>> 0` keeps it unsigned.
        hash = (hash +
            ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16);
}
/**
 * Read an explicit byte range. Returns the bytes actually read — short reads
 * are real when a writer is appending concurrently, and honoring the count
 * avoids decoding the untouched NUL tail of the buffer as content.
 *
 * @param {string} filePath
 * @param {number} start
 * @param {number} length
 * @returns {Buffer}
 */
function readRange(filePath, start, length) {
    if (length <= 0) {
        return Buffer.alloc(0);
    }
    // Allocate before opening: an alloc that throws between openSync and the
    // try/finally would leak the descriptor.
    const buffer = Buffer.alloc(length);
    const fd = openSync(filePath, "r");
    let bytesRead = 0;
    try {
        bytesRead = readSync(fd, buffer, 0, length, start);
    }
    finally {
        closeSync(fd);
    }
    return buffer.subarray(0, bytesRead);
}
/**
 * True when `offset` still sits just past a newline — i.e. the saved resume
 * point is still a line boundary in the file as it exists now. Cheap insurance
 * against a rewrite that shifts content without changing the head, which the
 * fingerprint would miss. Not a guarantee: it fails only when the shift happens
 * to leave a newline at exactly this offset, in which case the resume proceeds
 * on mismatched bytes. No known producer exists — compaction appends.
 *
 * @param {string} filePath
 * @param {number} offset
 * @returns {boolean}
 */
function isLineBoundary(filePath, offset) {
    if (offset === 0) {
        return true;
    }
    const prev = readRange(filePath, offset - 1, 1);
    return prev.length === 1 && prev[0] === 0x0a;
}
/**
 * Fingerprint a file's head so a different file reusing the same memo slot can
 * be told from an append to the same one.
 *
 * @param {string} filePath
 * @param {number} size
 * @returns {string}
 */
function fingerprintHead(filePath, size) {
    return fnv1a(readRange(filePath, 0, Math.min(FINGERPRINT_BYTES, size)));
}
/**
 * Sum `input_tokens + output_tokens` for one usage object. Cache read/creation
 * tokens are deliberately excluded — this figure tracks tokens *generated*, and
 * it matches how Claude Code's own task-budget accounting decrements. `ctx:`
 * is the element that reports the cache-inclusive context window.
 *
 * @param {any} usage
 * @returns {number}
 */
function tokensFromUsage(usage) {
    if (!usage) {
        return 0;
    }
    const input = typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
        ? usage.input_tokens
        : 0;
    const output = typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)
        ? usage.output_tokens
        : 0;
    return Math.max(0, Math.round(input)) + Math.max(0, Math.round(output));
}
/**
 * @typedef {Object} TallyMemo
 * @property {string} fp          Fingerprint of the file head when last tallied.
 * @property {number} consumed    Byte offset just past the last complete line parsed.
 * @property {number} total       De-duplicated token total for those bytes.
 * @property {string|null} lastId `message.id` of the final group in that range.
 * @property {number} lastIdTokens Tokens already counted for `lastId`.
 * @property {number} toolCalls    tool_use blocks seen — every tool, agents and skills included.
 * @property {number} agentCalls   Of those, Agent/Task invocations.
 * @property {number} skillCalls   Of those, Skill invocations.
 * @property {string|null} firstTimestamp `timestamp` of the first row carrying one (the session start).
 */
/** A memo for a file nothing has been read from. */
function emptyMemo() {
    return {
        fp: "", consumed: 0, total: 0, lastId: null, lastIdTokens: 0,
        toolCalls: 0, agentCalls: 0, skillCalls: 0, firstTimestamp: null,
    };
}
/** Field-wise memo equality, so a persist can be skipped when nothing moved. */
function sameMemo(a, b) {
    if (!a || !b)
        return false;
    for (const key of Object.keys(emptyMemo())) {
        if (a[key] !== b[key])
            return false;
    }
    return true;
}
/**
 * Tally one transcript file, resuming from `memo` when it still applies.
 *
 * The returned object is the next memo — callers persist it verbatim. On any
 * read error the previous memo is returned unchanged (so a file that rotates
 * mid-frame keeps its last good total instead of dropping to 0), or a zeroed
 * memo when there was none.
 *
 * @param {string} filePath
 * @param {number} size Current file size, from the caller's stat().
 * @param {TallyMemo|null|undefined} memo
 * @returns {TallyMemo}
 */
export function tallyFile(filePath, size, memo) {
    const empty = emptyMemo();
    try {
        if (!size || size <= 0) {
            return empty;
        }
        const fp = fingerprintHead(filePath, size);
        // Resume only when the head is unchanged, the file has not shrunk, and
        // the saved offset still lands on a line boundary. Any failure means
        // this is no longer the byte stream we measured, so the saved offset
        // would point into unrelated content — rescan from 0.
        const resumable = memo &&
            memo.fp === fp &&
            typeof memo.consumed === "number" &&
            memo.consumed >= 0 &&
            memo.consumed <= size &&
            typeof memo.total === "number" &&
            Number.isFinite(memo.total) &&
            // A memo from before the call counts existed carries none; resuming
            // it would count only the appended rows, so it rescans from 0 once.
            typeof memo.toolCalls === "number" &&
            typeof memo.agentCalls === "number" &&
            typeof memo.skillCalls === "number" &&
            // A recorded `null` is honest (no row carried a timestamp yet);
            // anything else means the field was lost, and resuming would adopt
            // a later row's timestamp as the session start.
            (memo.firstTimestamp === null || typeof memo.firstTimestamp === "string") &&
            isLineBoundary(filePath, memo.consumed);
        const start = resumable ? memo.consumed : 0;
        if (start === size) {
            // Nothing appended since the last frame.
            return resumable
                ? { ...memo, fp }
                : empty;
        }
        let total = resumable ? memo.total : 0;
        let lastId = resumable ? (memo.lastId ?? null) : null;
        let lastIdTokens = resumable && typeof memo.lastIdTokens === "number"
            ? memo.lastIdTokens
            : 0;
        let toolCalls = resumable ? memo.toolCalls : 0;
        let agentCalls = resumable ? memo.agentCalls : 0;
        let skillCalls = resumable ? memo.skillCalls : 0;
        let firstTimestamp = resumable && typeof memo.firstTimestamp === "string"
            ? memo.firstTimestamp
            : null;
        const chunk = readRange(filePath, start, size - start);
        if (chunk.length === 0) {
            return resumable ? { ...memo, fp } : empty;
        }
        // Only consume through the last complete line: a writer may be midway
        // through appending the next one. Slicing on the newline *byte* also
        // keeps the decode on a valid UTF-8 boundary, since `start` is itself
        // always a line boundary.
        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline < 0) {
            // A partial line with no terminator yet — consume nothing.
            return resumable ? { ...memo, fp } : empty;
        }
        const consumed = start + lastNewline + 1;
        const text = chunk.subarray(0, lastNewline + 1).toString("utf8");
        for (const line of text.split("\n")) {
            if (!line.trim()) {
                continue;
            }
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue; // Skip malformed lines
            }
            if (!entry || typeof entry !== "object") {
                continue;
            }
            if (firstTimestamp === null && typeof entry.timestamp === "string" && entry.timestamp) {
                firstTimestamp = entry.timestamp;
            }
            // Call counts. Safe to count per row: each assistant row carries
            // exactly one content block (0 rows with several, 0 repeated
            // tool_use ids, across 50 transcripts / 16,330 rows), so the rows
            // of one message never repeat a block.
            const content = entry.message?.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (!block || block.type !== "tool_use" || !block.id || !block.name) {
                        continue;
                    }
                    toolCalls++;
                    if (AGENT_TOOLS.has(block.name)) {
                        agentCalls++;
                    }
                    else if (SKILL_TOOLS.has(block.name)) {
                        skillCalls++;
                    }
                }
            }
            const usage = entry.message?.usage;
            if (!usage) {
                continue;
            }
            const tokens = tokensFromUsage(usage);
            const id = typeof entry.message?.id === "string" && entry.message.id
                ? entry.message.id
                : null;
            if (id && id === lastId) {
                // Another content block of the call we already counted. Replace
                // rather than add — every row of a group carries the same usage
                // snapshot, so last-wins and max agree (verified: 0 groups where
                // output_tokens decreases).
                total += tokens - lastIdTokens;
                lastIdTokens = tokens;
                continue;
            }
            total += tokens;
            lastId = id;
            lastIdTokens = tokens;
        }
        return {
            fp, consumed, total: Math.max(0, total), lastId, lastIdTokens,
            toolCalls, agentCalls, skillCalls, firstTimestamp,
        };
    }
    catch (error) {
        // A live transcript can rotate or vanish between the stat and the read.
        // Keep the previous total for this frame; the next one retries. Two
        // different routes get us there: subagents.js refuses to trust a memo
        // whose `consumed` falls short of the file size, and tallyLead
        // either skips the write entirely (memo returned unchanged) or persists
        // `fp: ""`, which can never match a real fingerprint.
        if (process.env.HUD_DEBUG) {
            console.error("[HUD] token tally read failed:", filePath, error instanceof Error ? error.message : error);
        }
        return memo && typeof memo.total === "number" ? memo : empty;
    }
}
/**
 * @typedef {Object} LeadTally
 * @property {number|null} totalTokens De-duplicated input+output total; null when the file holds no usage rows, so `token:` hides rather than reading 0.
 * @property {number} toolCalls
 * @property {number} agentCalls
 * @property {number} skillCalls
 * @property {Date|null} sessionStart Timestamp of the first row, or null when no row carries one.
 */
/**
 * Tally the lead transcript — token total, call counts and session start —
 * memoized across renders in the session cache dir as `lead-tokens.json` (the
 * HUD runs one process per frame, so an in-memory cache would never survive).
 *
 * Returns `null` when there is no usable transcript at all.
 *
 * @param {string|null|undefined} leadTranscriptPath
 * @param {string} [sessionKey]
 * @returns {LeadTally|null}
 */
export function tallyLead(leadTranscriptPath, sessionKey) {
    try {
        if (!leadTranscriptPath || !existsSync(leadTranscriptPath)) {
            return null;
        }
        const size = statSync(leadTranscriptPath).size;
        const cachePath = sessionKey ? sessionCacheFile("lead-tokens", sessionKey) : null;
        let memo = null;
        if (cachePath) {
            try {
                memo = JSON.parse(readFileSync(cachePath, "utf8"));
            }
            catch {
                memo = null;
            }
        }
        const next = tallyFile(leadTranscriptPath, size, memo);
        // Persist on any change — including the one-time migration of a memo
        // that predates the counters, where `consumed` and `total` stand still.
        if (cachePath && !sameMemo(memo, next)) {
            try {
                atomicWriteJsonSync(cachePath, next);
            }
            catch {
                // Best-effort; a missed write just re-scans next frame.
            }
        }
        const start = next.firstTimestamp ? new Date(next.firstTimestamp) : null;
        return {
            // No usage rows seen anywhere in the file → nothing meaningful to show.
            totalTokens: next.consumed > 0 && next.total > 0 ? next.total : null,
            toolCalls: next.toolCalls,
            agentCalls: next.agentCalls,
            skillCalls: next.skillCalls,
            sessionStart: start && !Number.isNaN(start.getTime()) ? start : null,
        };
    }
    catch (error) {
        if (process.env.HUD_DEBUG) {
            console.error("[HUD] lead token tally error:", error instanceof Error ? error.message : error);
        }
        return null;
    }
}
