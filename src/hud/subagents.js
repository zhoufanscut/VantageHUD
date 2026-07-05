/**
 * HUD - Subagent (teammate) token accumulation
 *
 * The lead session transcript that Claude Code hands the statusline no longer
 * contains subagent activity. Since the teammate rework, each teammate spawned
 * via the Agent tool writes its OWN transcript next to the lead one:
 *
 *   <lead-transcript without .jsonl>/subagents/agent-<name>-<hash>.jsonl
 *
 * (with a sibling `.meta.json`), sharing the parent `sessionId`. Those files
 * carry full per-turn token usage the lead transcript never sees, so the
 * `token:` element would otherwise undercount every multi-agent run — often by
 * the bulk of the work.
 *
 * `sumSubagentTokens` folds that usage into the session token total. It mirrors
 * the lead's accounting exactly (see transcript.js): the sum of
 * `input_tokens + output_tokens` per turn, excluding cache read/creation tokens.
 *
 * Because the HUD renders one Node process per frame, an in-memory cache would
 * never survive between frames — so per-file sums are memoized on disk in the
 * session cache dir, keyed on each teammate file's size+mtime. A static team
 * then costs one stat() per file; only files that grew since the last frame are
 * re-read. Any error yields 0: the HUD must never break on a subagent read.
 */
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync, } from "fs";
import { basename, dirname, join } from "path";
import { sessionCacheFile } from "../lib/worktree-paths.js";
import { atomicWriteJsonSync } from "../lib/atomic-write.js";
// Match transcript.js: only tail-read the last few MB of a huge teammate file.
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
// Backstop for pathological teams. Logged under HUD_DEBUG rather than silently
// truncated, so a capped sum never reads as "counted everything".
const MAX_SUBAGENT_FILES = 64;
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
        const files = readdirSync(dir).filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"));
        if (files.length === 0) {
            return 0;
        }
        if (files.length > MAX_SUBAGENT_FILES && process.env.HUD_DEBUG) {
            console.error(`[HUD] subagent token sum: ${files.length} teammate files, capping at ${MAX_SUBAGENT_FILES}`);
        }
        const capped = files.slice(0, MAX_SUBAGENT_FILES);
        // Per-file memo, keyed by filename → { key: "size:mtime", tokens }.
        // Survives the one-process-per-render model by living in the session
        // cache dir. Stale entries for removed files are dropped by rebuilding
        // the map from the current listing.
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
        for (const name of capped) {
            const filePath = join(dir, name);
            let stat;
            try {
                stat = statSync(filePath);
            }
            catch {
                continue;
            }
            const key = `${stat.size}:${Math.round(stat.mtimeMs)}`;
            const hit = cache[name];
            let tokens;
            if (hit && hit.key === key && typeof hit.tokens === "number") {
                tokens = hit.tokens;
            }
            else {
                tokens = sumTokensInFile(filePath, stat.size);
                changed = true;
            }
            next[name] = { key, tokens };
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
