/**
 * HUD - Transcript Parser
 *
 * Reads the tail of the lead transcript (`.jsonl`) for the one figure that
 * legitimately wants only recency: the **last request's token usage**, which
 * feeds `ctx:` when the live stdin `context_window` is zeroed (see
 * `getContextPercentFromUsage` in stdin.js).
 *
 * Nothing cumulative is computed here, on purpose. A tail read publishes a
 * truncated figure as a complete one — the old token total measured 39% of the
 * truth on a 25.4 MB transcript, and the old tool/agent/skill counts 89% on a
 * 4.9 MB one (442 of 494 tool calls, 2 of 3 agent calls) — and both can run
 * *backwards* as the window slides. Every running figure (tokens, call counts,
 * session start) therefore comes from token-tally.js, which scans the whole
 * file incrementally and memoizes the result per session.
 */
import { existsSync, statSync, openSync, readSync, closeSync } from "fs";
// The last usage row sits near the end of the file, but a single large
// tool_result row can precede it; 4 MiB leaves ample room.
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
/**
 * @typedef {Object} LastRequestTokenUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [reasoningTokens]
 * @property {number} [cacheReadInputTokens]
 * @property {number} [cacheCreationInputTokens]
 */
/**
 * Read the last request's token usage from the transcript tail.
 * Never throws: a missing or unreadable transcript yields no usage.
 *
 * Scans the window backwards and stops at the first line, counted from the
 * end, that carries usage — the same row the old forward last-wins loop kept,
 * but usually after parsing one line instead of every line in 4 MiB (measured
 * on a 5.5 MB transcript: ~28 ms → ~2 ms per call).
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {{ lastRequestTokenUsage: LastRequestTokenUsage|undefined }}
 */
export function parseTranscript(transcriptPath) {
    const result = { lastRequestTokenUsage: undefined };
    if (!transcriptPath || !existsSync(transcriptPath)) {
        return result;
    }
    try {
        const fileSize = statSync(transcriptPath).size;
        const { buffer, partialFirstLine } = readTail(transcriptPath, fileSize, MAX_TAIL_BYTES);
        let end = buffer.length;
        while (end > 0) {
            const newline = buffer.lastIndexOf(NEWLINE, end - 1);
            // When the window starts mid-file, its first line is a fragment
            // (possibly a split UTF-8 sequence): every whole JSONL line ends
            // with '\n', so nothing before the first one is usable.
            if (newline < 0 && partialFirstLine)
                break;
            const line = buffer.subarray(newline + 1, end);
            end = Math.max(0, newline);
            // Cheap byte test before the parse: most rows (tool results, user
            // turns) carry no usage, and some of them are very large.
            if (!line.includes(USAGE_KEY))
                continue;
            let entry;
            try {
                entry = JSON.parse(line.toString("utf8"));
            }
            catch {
                continue; // Skip malformed (or still being written) lines
            }
            const usage = extractLastRequestTokenUsage(entry?.message?.usage);
            if (usage) {
                result.lastRequestTokenUsage = usage;
                break;
            }
        }
    }
    catch {
        // Unreadable, or rotated mid-frame — nothing to report this frame.
    }
    return result;
}
const NEWLINE = 0x0a;
const USAGE_KEY = Buffer.from('"usage"');
/**
 * Read the last `maxBytes` of a file. `partialFirstLine` is true when the read
 * started mid-file, so the bytes before the first newline are a fragment.
 */
function readTail(filePath, fileSize, maxBytes) {
    const startOffset = Math.max(0, fileSize - maxBytes);
    const bytesToRead = fileSize - startOffset;
    if (bytesToRead <= 0) {
        return { buffer: Buffer.alloc(0), partialFirstLine: false };
    }
    const buffer = Buffer.alloc(bytesToRead);
    const fd = openSync(filePath, "r");
    let bytesRead = 0;
    try {
        bytesRead = readSync(fd, buffer, 0, bytesToRead, startOffset);
    }
    finally {
        closeSync(fd);
    }
    return { buffer: buffer.subarray(0, bytesRead), partialFirstLine: startOffset > 0 };
}
function extractLastRequestTokenUsage(usage) {
    if (!usage)
        return null;
    const inputTokens = getNumericUsageValue(usage.input_tokens);
    const outputTokens = getNumericUsageValue(usage.output_tokens);
    const reasoningTokens = getNumericUsageValue(usage.reasoning_tokens
        ?? usage.output_tokens_details?.reasoning_tokens
        ?? usage.output_tokens_details?.reasoningTokens
        ?? usage.completion_tokens_details?.reasoning_tokens
        ?? usage.completion_tokens_details?.reasoningTokens);
    // Cache-side input tokens. Captured so the context element can fall back to
    // the transcript when the live stdin context_window is zeroed (see
    // getContextPercentFromUsage in stdin.js). For Anthropic these carry the
    // bulk of the prompt; for non-Anthropic providers they are typically 0.
    const cacheReadInputTokens = getNumericUsageValue(usage.cache_read_input_tokens
        ?? usage.cacheReadInputTokens);
    const cacheCreationInputTokens = getNumericUsageValue(usage.cache_creation_input_tokens
        ?? usage.cacheCreationInputTokens);
    if (inputTokens == null && outputTokens == null) {
        return null;
    }
    const normalized = {
        inputTokens: Math.max(0, Math.round(inputTokens ?? 0)),
        outputTokens: Math.max(0, Math.round(outputTokens ?? 0)),
    };
    if (reasoningTokens != null && reasoningTokens > 0) {
        normalized.reasoningTokens = Math.max(0, Math.round(reasoningTokens));
    }
    if (cacheReadInputTokens != null && cacheReadInputTokens > 0) {
        normalized.cacheReadInputTokens = Math.max(0, Math.round(cacheReadInputTokens));
    }
    if (cacheCreationInputTokens != null && cacheCreationInputTokens > 0) {
        normalized.cacheCreationInputTokens = Math.max(0, Math.round(cacheCreationInputTokens));
    }
    return normalized;
}
function getNumericUsageValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
