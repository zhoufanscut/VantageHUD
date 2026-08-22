#!/usr/bin/env node
/**
 * HUD - Main Entry Point
 *
 * Statusline command that visualizes claude-statusline state.
 * Receives stdin JSON from Claude Code and outputs formatted statusline.
 */
import { readStdin, writeStdinCache, readStdinCache, getContextPercent, getContextPercentFromUsage, getModelId, getModelName, getEffortLevel, getRateLimitsFromStdin, stabilizeContextPercent, } from "./stdin.js";
import { parseTranscript } from "./transcript.js";
import { sumSubagentTokens } from "./subagents.js";
import { sumLeadTokens } from "./token-tally.js";
import { readHudState, readHudConfig, writeHudState, } from "./state.js";
import { getUsage } from "./usage-api.js";
import { render } from "./render.js";
import { sanitizeOutput } from "./sanitize.js";
import { resolveToWorktreeRoot, resolveTranscriptPath, sessionCacheFile } from "../lib/worktree-paths.js";
import { atomicWriteJsonSync } from "../lib/atomic-write.js";
/**
 * Extract session ID (UUID) from a transcript path.
 */
function extractSessionIdFromPath(transcriptPath) {
    if (!transcriptPath)
        return null;
    const match = transcriptPath.match(/([0-9a-f-]{36})(?:\.jsonl)?$/i);
    return match ? match[1] : null;
}
/**
 * Resolve the session key that names every per-session cache file.
 *
 * Prefers `HUD_SESSION_KEY` — the key statusline.sh computed for this render
 * and exported when it spawned Node. It names the folder the shell already
 * wrote `stdin.json`/`statusline.txt` into, so trusting it first means the two
 * layers cannot diverge even when the shell's naive `session_id` extraction
 * and a real JSON parse would disagree, or the shell fell back to a
 * transcript/cwd checksum Node cannot recompute. The remaining fallbacks
 * (stdin `session_id`, session-id env vars, the transcript-derived UUID,
 * `default`) cover direct `node statusline.mjs` runs without the wrapper.
 */
function resolveSessionKey(stdin) {
    return (process.env.HUD_SESSION_KEY
        || stdin?.session_id
        || process.env.CLAUDE_CODE_SESSION_ID
        || process.env.CLAUDE_SESSION_ID
        || process.env.CLAUDECODE_SESSION_ID
        || extractSessionIdFromPath(stdin?.transcript_path ?? "")
        || "default");
}
function mergeStdinRateLimits(stdinRateLimits, usageResult) {
    if (!stdinRateLimits) {
        return usageResult;
    }
    return {
        ...(usageResult ?? {}),
        rateLimits: {
            ...(usageResult?.rateLimits ?? {}),
            ...stdinRateLimits,
        },
    };
}
/**
 * Build the sessionHealth data (session duration) from the session start time.
 */
function calculateSessionHealth(sessionStart) {
    const durationMs = sessionStart ? Date.now() - sessionStart.getTime() : 0;
    const durationMinutes = Math.floor(durationMs / 60_000);
    return { durationMinutes };
}
/**
 * Main HUD entry point
 */
async function main() {
    try {
        // Read stdin from Claude Code first — the session key (and therefore
        // every per-session cache file) falls back to it when the shell
        // wrapper didn't export HUD_SESSION_KEY.
        let stdin = await readStdin();
        if (!stdin) {
            // No piped stdin (e.g. invoked directly) — nothing to render.
            return;
        }
        const sessionKey = resolveSessionKey(stdin);
        // Carry the previous frame's context% across Claude Code's transient
        // all-null context_window snapshots. The cache is per-session, so other
        // sessions in this directory can no longer clobber it.
        const previousStdinCache = readStdinCache(sessionKey);
        stdin = stabilizeContextPercent(stdin, previousStdinCache);
        writeStdinCache(stdin, sessionKey);
        const cwd = resolveToWorktreeRoot(stdin.cwd || undefined);
        // Read configuration.
        // Clone to avoid mutating shared DEFAULT_HUD_CONFIG when applying runtime width detection
        const config = { ...readHudConfig() };
        // Auto-detect terminal width if not explicitly configured (#1726)
        // Prefer live TTY columns (responds to resize) over static COLUMNS env var
        if (config.maxWidth === undefined) {
            const cols = process.stderr.columns ||
                process.stdout.columns ||
                parseInt(process.env.COLUMNS ?? "0", 10) ||
                0;
            if (cols > 0) {
                config.maxWidth = cols;
                if (config.wrapMode === "truncate")
                    config.wrapMode = "wrap";
            }
        }
        // Resolve worktree-mismatched transcript paths (issue #1094)
        const resolvedTranscriptPath = resolveTranscriptPath(stdin.transcript_path, cwd);
        // Parse transcript for tool/skill counts, tokens, todos, and prompt-cache age
        const transcriptData = await parseTranscript(resolvedTranscriptPath);
        // Read HUD state (persists the real session start across tail-parsing resets)
        const hudState = readHudState(cwd, sessionKey);
        // Persist session start time to survive tail-parsing resets (#528)
        // When tail parsing kicks in for large transcripts, sessionStart comes from
        // the first entry in the tail chunk rather than the actual session start.
        // We persist the real start time in HUD state on first observation.
        // Scoped per session ID so a new session in the same cwd resets the timestamp.
        let sessionStart = transcriptData.sessionStart;
        const sameSession = hudState?.sessionId === sessionKey;
        if (sameSession && hudState?.sessionStartTimestamp) {
            // Use persisted value (the real session start) - but validate first
            const persisted = new Date(hudState.sessionStartTimestamp);
            if (!isNaN(persisted.getTime())) {
                sessionStart = persisted;
            }
            // If invalid, fall through to transcript-derived sessionStart
        }
        else if (sessionStart) {
            // First time seeing session start (or new session) - persist it
            const stateToWrite = hudState || {
                timestamp: new Date().toISOString(),
            };
            stateToWrite.sessionStartTimestamp = sessionStart.toISOString();
            stateToWrite.sessionId = sessionKey;
            stateToWrite.timestamp = new Date().toISOString();
            writeHudState(stateToWrite, cwd, sessionKey);
        }
        // Merge Claude Code stdin generic buckets with API/cache-specific fields.
        // Stdin owns fresher five-hour/seven-day values, while getUsage() may provide
        // Sonnet/Opus weekly, monthly, extra, stale, and error metadata.
        const stdinRateLimits = getRateLimitsFromStdin(stdin);
        const usageResult = config.elements.rateLimits === false ? null : await getUsage();
        const rateLimitsResult = config.elements.rateLimits === false
            ? null
            : mergeStdinRateLimits(stdinRateLimits, usageResult);
        // Native stdin context_window is authoritative when present, but Claude
        // Code zeroes it between turns and non-Anthropic providers (API token +
        // ANTHROPIC_BASE_URL) leave it zeroed far more often. When it yields 0,
        // recover the value from the transcript's last-request usage so ctx does
        // not collapse to 0% on idle frames or after a cross-session cache clobber.
        let contextPercent = getContextPercent(stdin);
        if (contextPercent === 0) {
            const contextFromUsage = getContextPercentFromUsage(stdin, transcriptData.lastRequestTokenUsage);
            if (contextFromUsage != null) {
                contextPercent = contextFromUsage;
            }
        }
        // Fold teammate/subagent token usage into the session total. Teammates
        // spawned via the Agent tool — and every Workflow-tool agent — write
        // their own transcripts under <lead>/subagents/ that this session's
        // transcript never sees, so `token:` would otherwise undercount every
        // multi-agent run. Both sides run through the same de-duplicating,
        // incremental tally (token-tally.js), so they cannot drift apart in how
        // they count. Only enrich a trustworthy lead total (null → hidden).
        const leadTotalTokens = sumLeadTokens(resolvedTranscriptPath, sessionKey);
        const sessionTotalTokens = leadTotalTokens != null
            ? leadTotalTokens + sumSubagentTokens(resolvedTranscriptPath, sessionKey)
            : null;
        // Build render context
        const context = {
            contextPercent,
            modelName: getModelName(stdin),
            modelId: getModelId(stdin),
            effortLevel: getEffortLevel(stdin),
            cwd,
            rateLimitsResult,
            sessionHealth: calculateSessionHealth(sessionStart),
            lastRequestTokenUsage: transcriptData.lastRequestTokenUsage || null,
            sessionTotalTokens,
            toolCallCount: transcriptData.toolCallCount,
            agentCallCount: transcriptData.agentCallCount,
            skillCallCount: transcriptData.skillCallCount,
        };
        // Debug: log data if HUD_DEBUG is set
        if (process.env.HUD_DEBUG) {
            console.error("[HUD DEBUG] stdin.context_window:", JSON.stringify(stdin.context_window));
            console.error("[HUD DEBUG] sessionHealth:", JSON.stringify(context.sessionHealth));
        }
        // autoCompact: write trigger file when token context exceeds threshold.
        // Payload pressure is warning-only for now because statusline hooks can
        // estimate from local transcript artifacts but do not receive Claude Code's
        // exact serialized API request body.
        // A companion hook can read this file to inject a /compact suggestion.
        if (config.contextLimitWarning.autoCompact &&
            context.contextPercent >= config.contextLimitWarning.threshold) {
            try {
                const triggerFile = sessionCacheFile("compact-requested", sessionKey);
                atomicWriteJsonSync(triggerFile, {
                    requestedAt: new Date().toISOString(),
                    contextPercent: context.contextPercent,
                    threshold: config.contextLimitWarning.threshold,
                });
            }
            catch (error) {
                // Silent failure — don't break HUD rendering
                if (process.env.HUD_DEBUG) {
                    console.error("[HUD] Auto-compact trigger write error:", error instanceof Error ? error.message : error);
                }
            }
        }
        // Render and output
        let output = await render(context, config);
        // Apply safe mode sanitization if enabled (Issue #346)
        // This strips ANSI codes and uses ASCII-only output to prevent
        // terminal rendering corruption during concurrent updates.
        // On Windows, default to safe mode unless the user explicitly sets safeMode: false
        // (e.g. Windows Terminal and modern terminals support ANSI natively).
        // The win32 fallback is retained for configs that omit safeMode entirely
        // (before default merge, e.g. minimal config files or future schema changes).
        // explicit false overrides platform detection: process.platform === 'win32'
        const useSafeMode = config.elements.safeMode !== false &&
            (config.elements.safeMode || process.platform === "win32");
        if (useSafeMode) {
            output = sanitizeOutput(output);
            // In safe mode, use regular spaces (don't convert to non-breaking)
            console.log(output);
        }
        else {
            // Replace spaces with non-breaking spaces for terminal alignment
            const formattedOutput = output.replace(/ /g, "\u00A0");
            console.log(formattedOutput);
        }
    }
    catch (error) {
        // Distinguish installation errors from runtime errors
        const isInstallError = error instanceof Error &&
            (error.message.includes("ENOENT") ||
                error.message.includes("MODULE_NOT_FOUND") ||
                error.message.includes("Cannot find module"));
        if (isInstallError) {
            console.log("[HUD] run /setup to install properly");
        }
        else {
            // Output fallback message to stdout for status line visibility
            console.log("[HUD] HUD error - check stderr");
            // Log actual runtime errors to stderr for debugging
            console.error("[HUD Error]", error instanceof Error ? error.message : error);
        }
    }
}
// Auto-run (unconditional so dynamic import() via statusline.mjs wrapper works correctly)
main();
