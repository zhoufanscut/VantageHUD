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
 * no `isSidechain` turns of its own, so folding them in is purely additive —
 * there is nothing here to double-count. `sumSubagentTokens` mirrors the lead's
 * accounting exactly (see transcript.js): the sum of `input_tokens +
 * output_tokens` per turn, excluding cache read/creation tokens.
 *
 * Because the HUD renders one Node process per frame, an in-memory cache would
 * never survive between frames — so per-file sums are memoized on disk in the
 * session cache dir, keyed on each file's size+mtime under its path relative to
 * the subagents dir. A static team then costs one stat() per file; only files
 * that grew since the last frame are re-read. Any error yields 0: the HUD must
 * never break on a subagent read.
 */
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync, } from "fs";
import { basename, dirname, join, relative } from "path";
import { sessionCacheFile } from "../lib/worktree-paths.js";
import { atomicWriteJsonSync } from "../lib/atomic-write.js";
// Match transcript.js: only tail-read the last few MB of a huge teammate file.
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
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
 * Sum `input_tokens + output_tokens` for a single usage object, matching the
 * lead's accounting (cache read/creation tokens are excluded there too).
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
 * Read one teammate transcript and sum tokens across its turns. Files larger
 * than MAX_TAIL_BYTES are tail-read (a partial sum, matching the lead's
 * large-transcript behavior); the first line of a mid-file read is discarded
 * because it may be a torn JSON row or a split multi-byte sequence.
 */
function sumTokensInFile(filePath, fileSize) {
    let content;
    if (fileSize > MAX_TAIL_BYTES) {
        const startOffset = fileSize - MAX_TAIL_BYTES;
        const fd = openSync(filePath, "r");
        const buffer = Buffer.alloc(MAX_TAIL_BYTES);
        try {
            readSync(fd, buffer, 0, MAX_TAIL_BYTES, startOffset);
        }
        finally {
            closeSync(fd);
        }
        content = buffer.toString("utf8");
        const firstNewline = content.indexOf("\n");
        content = firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
    }
    else {
        content = readFileSync(filePath, "utf8");
    }
    let total = 0;
    for (const line of content.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        try {
            total += tokensFromUsage(JSON.parse(line).message?.usage);
        }
        catch {
            // Skip malformed lines
        }
    }
    return total;
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
 * Sum input+output tokens across every teammate transcript under this lead
 * session, memoized per file on disk. Returns 0 when there are no teammates or
 * on any error (never throws).
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
        // Per-file memo, keyed by path relative to the subagents dir →
        // { key: "size:mtime", tokens }. Survives the one-process-per-render
        // model by living in the session cache dir. Stale entries for removed
        // files are dropped by rebuilding the map from the current listing.
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
            const key = `${file.size}:${Math.round(file.mtimeMs)}`;
            const hit = cache[file.rel];
            let tokens;
            if (hit && hit.key === key && typeof hit.tokens === "number") {
                tokens = hit.tokens;
            }
            else {
                try {
                    tokens = sumTokensInFile(file.path, file.size);
                }
                catch {
                    // A live teammate file can rotate or vanish between the walk
                    // and the read. Fall back to its last good sum rather than
                    // dropping the teammate to 0 for this frame. Store `hit`
                    // verbatim — under its OLD key — so the mismatch survives and
                    // the next frame retries, instead of freezing a stale value.
                    if (hit && typeof hit.tokens === "number") {
                        next[file.rel] = hit;
                        total += hit.tokens;
                    }
                    continue;
                }
                changed = true;
            }
            next[file.rel] = { key, tokens };
            total += tokens;
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
