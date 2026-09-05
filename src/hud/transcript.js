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
        for (const line of readTailLines(transcriptPath, fileSize, MAX_TAIL_BYTES)) {
            if (!line.trim())
                continue;
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue; // Skip malformed lines
            }
            const usage = extractLastRequestTokenUsage(entry?.message?.usage);
            if (usage) {
                result.lastRequestTokenUsage = usage;
            }
        }
    }
    catch {
        // Unreadable, or rotated mid-frame — nothing to report this frame.
    }
    return result;
}
/**
 * Read the tail portion of a file and split into lines.
 * Handles partial first line (from mid-file start).
 */
function readTailLines(filePath, fileSize, maxBytes) {
    const startOffset = Math.max(0, fileSize - maxBytes);
    const bytesToRead = fileSize - startOffset;
    if (bytesToRead <= 0) {
        return [];
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
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = content.split("\n");
    // If we started mid-file, discard the potentially incomplete first line.
    // This also handles UTF-8 multi-byte boundary splits: the first chunk may
    // start in the middle of a multi-byte sequence, producing a garbled line.
    // Discarding it is safe because every valid JSONL line ends with '\n'.
    if (startOffset > 0 && lines.length > 0) {
        lines.shift();
    }
    return lines;
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
