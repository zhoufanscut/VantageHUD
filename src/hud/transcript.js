/**
 * HUD - Transcript Parser
 *
 * Parse JSONL transcript from Claude Code to extract tool/skill counts, token
 * usage, todos, and prompt-cache age. Based on claude-hud reference implementation.
 *
 * Performance optimizations:
 * - Tail-based parsing: reads only the last few MB of large transcripts
 */
import { createReadStream, existsSync, statSync, openSync, readSync, closeSync, } from "fs";
import { createInterface } from "readline";
import { basename } from "path";
// Performance constants
// 4MB tail window: large enough that token-usage and prompt-cache-age signals for
// long sessions still fall inside the parsed window.
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
/**
 * Tools known to require permission approval in Claude Code.
 * Only these tools will trigger the "APPROVE?" indicator.
 */
const PERMISSION_TOOLS = [
    "Edit",
    "Write",
    "Bash",
    "proxy_Edit",
    "proxy_Write",
    "proxy_Bash",
];
/**
 * Time threshold for considering a tool "pending approval".
 * If tool_use exists without tool_result within this window, show indicator.
 */
const PERMISSION_THRESHOLD_MS = 3000; // 3 seconds
/**
 * Module-level map tracking pending permission-requiring tools.
 * Key: tool_use block id, Value: PendingPermission info
 * Cleared when tool_result is received for the corresponding tool_use.
 */
const pendingPermissionMap = new Map();
const transcriptCache = new Map();
const TRANSCRIPT_CACHE_MAX_SIZE = 20;
export async function parseTranscript(transcriptPath) {
    pendingPermissionMap.clear();
    const result = {
        todos: [],
        lastActivatedSkill: undefined,
        toolCallCount: 0,
        agentCallCount: 0,
        skillCallCount: 0,
        lastToolName: null,
        lastPromptTime: undefined,
        lastActivityTime: undefined,
    };
    if (!transcriptPath || !existsSync(transcriptPath)) {
        return result;
    }
    let cacheKey = null;
    try {
        const stat = statSync(transcriptPath);
        cacheKey = `${transcriptPath}:${stat.size}:${stat.mtimeMs}`;
        const cached = transcriptCache.get(transcriptPath);
        if (cached?.cacheKey === cacheKey) {
            return finalizeTranscriptResult(cloneTranscriptData(cached.baseResult), cached.pendingPermissions);
        }
    }
    catch {
        return result;
    }
    const latestTodos = [];
    const sessionTokenTotals = {
        inputTokens: 0,
        outputTokens: 0,
        seenUsage: false,
    };
    let sessionTotalsReliable = false;
    const observedSessionIds = new Set();
    try {
        const stat = statSync(transcriptPath);
        const fileSize = stat.size;
        if (fileSize > MAX_TAIL_BYTES) {
            const lines = readTailLines(transcriptPath, fileSize, MAX_TAIL_BYTES);
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const entry = JSON.parse(line);
                    processEntry(entry, latestTodos, result, sessionTokenTotals, observedSessionIds);
                }
                catch {
                    // Skip malformed lines
                }
            }
            // Token totals from a tail-read are partial (we only saw the last MAX_TAIL_BYTES).
            // Still surface them when token data was found so the HUD shows something useful.
            sessionTotalsReliable = sessionTokenTotals.seenUsage;
        }
        else {
            const fileStream = createReadStream(transcriptPath);
            const rl = createInterface({
                input: fileStream,
                crlfDelay: Infinity,
            });
            for await (const line of rl) {
                if (!line.trim())
                    continue;
                try {
                    const entry = JSON.parse(line);
                    processEntry(entry, latestTodos, result, sessionTokenTotals, observedSessionIds);
                }
                catch {
                    // Skip malformed lines
                }
            }
            sessionTotalsReliable = observedSessionIds.size <= 1;
        }
    }
    catch {
        return finalizeTranscriptResult(result, []);
    }
    result.todos = latestTodos;
    if (sessionTotalsReliable && sessionTokenTotals.seenUsage) {
        result.sessionTotalTokens = sessionTokenTotals.inputTokens + sessionTokenTotals.outputTokens;
    }
    const pendingPermissions = Array.from(pendingPermissionMap.values()).map(clonePendingPermission);
    const finalized = finalizeTranscriptResult(result, pendingPermissions);
    if (cacheKey) {
        if (transcriptCache.size >= TRANSCRIPT_CACHE_MAX_SIZE) {
            transcriptCache.clear();
        }
        transcriptCache.set(transcriptPath, {
            cacheKey,
            baseResult: cloneTranscriptData(finalized),
            pendingPermissions,
        });
    }
    return finalized;
}
/**
 * Read the tail portion of a file and split into lines.
 * Handles partial first line (from mid-file start).
 */
function cloneDate(value) {
    return value ? new Date(value.getTime()) : undefined;
}
function clonePendingPermission(permission) {
    return {
        ...permission,
        timestamp: new Date(permission.timestamp.getTime()),
    };
}
function cloneTranscriptData(result) {
    return {
        ...result,
        todos: result.todos.map((todo) => ({ ...todo })),
        sessionStart: cloneDate(result.sessionStart),
        lastPromptTime: cloneDate(result.lastPromptTime),
        lastActivityTime: cloneDate(result.lastActivityTime),
        lastActivatedSkill: result.lastActivatedSkill
            ? {
                ...result.lastActivatedSkill,
                timestamp: new Date(result.lastActivatedSkill.timestamp.getTime()),
            }
            : undefined,
        pendingPermission: result.pendingPermission
            ? clonePendingPermission(result.pendingPermission)
            : undefined,
        lastRequestTokenUsage: result.lastRequestTokenUsage
            ? { ...result.lastRequestTokenUsage }
            : undefined,
    };
}
function finalizeTranscriptResult(result, pendingPermissions) {
    const now = Date.now();
    result.pendingPermission = undefined;
    for (const permission of pendingPermissions) {
        const age = now - permission.timestamp.getTime();
        if (age <= PERMISSION_THRESHOLD_MS) {
            result.pendingPermission = clonePendingPermission(permission);
            break;
        }
    }
    return result;
}
function readTailLines(filePath, fileSize, maxBytes) {
    const startOffset = Math.max(0, fileSize - maxBytes);
    const bytesToRead = fileSize - startOffset;
    const fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(bytesToRead);
    try {
        readSync(fd, buffer, 0, bytesToRead, startOffset);
    }
    finally {
        closeSync(fd);
    }
    const content = buffer.toString("utf8");
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
/**
 * Extract a human-readable target summary from tool input.
 */
function extractTargetSummary(input, toolName) {
    if (!input || typeof input !== "object")
        return "...";
    const inp = input;
    // Edit/Write: show file path
    if (toolName.includes("Edit") || toolName.includes("Write")) {
        const filePath = inp.file_path;
        if (filePath) {
            // Return just the filename or last path segment
            return basename(filePath) || filePath;
        }
    }
    // Bash: show first 20 chars of command
    if (toolName.includes("Bash")) {
        const cmd = inp.command;
        if (cmd) {
            const trimmed = cmd.trim().substring(0, 20);
            return trimmed.length < cmd.trim().length ? `${trimmed}...` : trimmed;
        }
    }
    return "...";
}
/**
 * Process a single transcript entry
 */
function processEntry(entry, latestTodos, result, sessionTokenTotals, observedSessionIds) {
    const timestamp = entry.timestamp ? new Date(entry.timestamp) : new Date();
    if (entry.sessionId) {
        observedSessionIds?.add(entry.sessionId);
    }
    const usage = extractLastRequestTokenUsage(entry.message?.usage);
    if (usage) {
        result.lastRequestTokenUsage = usage;
        if (sessionTokenTotals) {
            sessionTokenTotals.inputTokens += usage.inputTokens;
            sessionTokenTotals.outputTokens += usage.outputTokens;
            sessionTokenTotals.seenUsage = true;
        }
    }
    // Set session start time from first entry
    if (!result.sessionStart && entry.timestamp) {
        result.sessionStart = timestamp;
    }
    // Prompt-cache-age signal. Every main-thread user/assistant entry is an API
    // round-trip that re-reads (and refreshes the TTL on) the prompt cache —
    // typed prompts, tool_results (incl. AskUserQuestion answers), and assistant
    // turns alike. Track the most recent one so promptTime reflects true cache
    // age, not just the last thing the user typed. Entries are chronological;
    // the last wins. A real timestamp is required to avoid the new Date()
    // fallback poisoning the gauge.
    //
    // Current Claude Code writes each teammate/subagent to its own transcript
    // under <lead>/subagents/ (see subagents.js), so the lead transcript parsed
    // here holds no inline `isSidechain` entries. The guard is kept for older
    // transcripts (and forward-compat) where sidechains appeared inline and
    // would otherwise touch a separate cache yet poison the lead's cache-age
    // gauge.
    if (entry.timestamp && !entry.isSidechain && !entry.isMeta &&
        (entry.type === "user" || entry.type === "assistant")) {
        result.lastActivityTime = timestamp;
    }
    const content = entry.message?.content;
    // String-shaped user content carries the most recent real user-typed prompt.
    // Assistant turns and tool results use array content; task-notifications and
    // slash-command / command-output entries (<command-name>, <local-command-stdout>,
    // <local-command-caveat>, …) are string-content user entries that start with
    // "<". Requiring a real timestamp avoids the new Date() fallback poisoning the
    // gauge. Entries are chronological, so the last wins.
    if (typeof content === "string") {
        if (entry.timestamp && entry.type === "user" && !entry.isMeta && !entry.isCompactSummary && !content.trimStart().startsWith("<")) {
            result.lastPromptTime = timestamp;
        }
        return;
    }
    if (!content || !Array.isArray(content))
        return;
    for (const block of content) {
        // Track tool_use for Task (agents) and TodoWrite
        if (block.type === "tool_use" && block.id && block.name) {
            result.toolCallCount++;
            result.lastToolName = block.name;
            if (block.name === "Task" || block.name === "proxy_Task" || block.name === "Agent") {
                result.agentCallCount++;
            }
            else if (block.name === "TodoWrite" || block.name === "proxy_TodoWrite") {
                const input = block.input;
                if (input?.todos && Array.isArray(input.todos)) {
                    // Replace latest todos with new ones
                    latestTodos.length = 0;
                    latestTodos.push(...input.todos.map((t) => ({
                        content: t.content,
                        status: t.status,
                        activeForm: t.activeForm,
                    })));
                }
            }
            else if (block.name === "Skill" || block.name === "proxy_Skill") {
                result.skillCallCount++;
                // Track last activated skill
                const input = block.input;
                if (input?.skill) {
                    result.lastActivatedSkill = {
                        name: input.skill,
                        args: input.args,
                        timestamp: timestamp,
                    };
                }
            }
            // Track tool_use for permission-requiring tools
            if (PERMISSION_TOOLS.includes(block.name)) {
                pendingPermissionMap.set(block.id, {
                    toolName: block.name.replace("proxy_", ""),
                    targetSummary: extractTargetSummary(block.input, block.name),
                    timestamp: timestamp,
                });
            }
        }
        // Clear pending permissions when the tool_result for that tool arrives.
        if (block.type === "tool_result" && block.tool_use_id) {
            pendingPermissionMap.delete(block.tool_use_id);
        }
    }
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
