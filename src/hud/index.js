#!/usr/bin/env node
/**
 * HUD - Main Entry Point
 *
 * Statusline command that visualizes claude-statusline state.
 * Receives stdin JSON from Claude Code and outputs formatted statusline.
 */
import { readStdin, writeStdinCache, readStdinCache, getContextPercent, getContextPercentFromUsage, getModelId, getModelName, getEffortLevel, getRateLimitsFromStdin, stabilizeContextPercent, } from "./stdin.js";
import { parseTranscript } from "./transcript.js";
import { readHudState, readHudConfig, getRunningTasks, writeHudState, initializeHUDState, } from "./state.js";
import { getUsage } from "./usage-api.js";
import { render } from "./render.js";
import { detectApiKeySource } from "./elements/api-key-source.js";
import { sanitizeOutput } from "./sanitize.js";
import { estimatePayloadFromTranscriptPath } from "./payload-estimate.js";
import { resolveToWorktreeRoot, resolveTranscriptPath, sessionCacheFile, ensureCacheDir } from "../lib/worktree-paths.js";
import { writeFileSync } from "fs";
import { basename } from "path";
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
 * Prefers Claude Code's stdin `session_id` (the same value statusline.sh uses
 * for `stdin.<session>.json`, so filenames line up), then the session-id env
 * vars, then the transcript-derived UUID. Falls back to `default` so a payload
 * with no session info still gets a stable, self-consistent file.
 */
function resolveSessionKey(stdin) {
    return (stdin?.session_id
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
 * Calculate session health from session start time and context usage.
 */
async function calculateSessionHealth(sessionStart, contextPercent) {
    const durationMs = sessionStart ? Date.now() - sessionStart.getTime() : 0;
    const durationMinutes = Math.floor(durationMs / 60_000);
    let health = "healthy";
    if (durationMinutes > 120 || contextPercent > 85)
        health = "critical";
    else if (durationMinutes > 60 || contextPercent > 70)
        health = "warning";
    return { durationMinutes, messageCount: 0, health };
}
/**
 * Main HUD entry point
 */
async function main() {
    try {
        // Read stdin from Claude Code first — the session key (and therefore
        // every per-session cache file) is derived from it.
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
        // Read configuration (before transcript parsing so we can use staleTaskThresholdMinutes)
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
        // Parse transcript for agents and todos
        const transcriptData = await parseTranscript(resolvedTranscriptPath, {
            staleTaskThresholdMinutes: config.staleTaskThresholdMinutes,
        });
        // Initialize HUD state (cleanup stale/orphaned tasks)
        await initializeHUDState(cwd, sessionKey);
        // Read HUD state for background tasks
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
                backgroundTasks: [],
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
        const payloadEstimate = estimatePayloadFromTranscriptPath(resolvedTranscriptPath);
        // Build render context
        const context = {
            contextPercent,
            contextDisplayScope: sessionKey,
            modelName: getModelName(stdin),
            modelId: getModelId(stdin),
            effortLevel: getEffortLevel(stdin),
            activeAgents: transcriptData.agents.filter((a) => a.status === "running"),
            todos: transcriptData.todos,
            backgroundTasks: getRunningTasks(hudState),
            cwd,
            lastSkill: transcriptData.lastActivatedSkill || null,
            rateLimitsResult,
            pendingPermission: transcriptData.pendingPermission || null,
            sessionHealth: await calculateSessionHealth(sessionStart, contextPercent),
            lastRequestTokenUsage: transcriptData.lastRequestTokenUsage || null,
            sessionTotalTokens: transcriptData.sessionTotalTokens ?? null,
            toolCallCount: transcriptData.toolCallCount,
            agentCallCount: transcriptData.agentCallCount,
            skillCallCount: transcriptData.skillCallCount,
            promptTime: transcriptData.lastPromptTime
                ?? (hudState?.lastPromptTimestamp
                    ? new Date(hudState.lastPromptTimestamp)
                    : null),
            apiKeySource: config.elements.apiKeySource
                ? detectApiKeySource(cwd)
                : null,
            profileName: process.env.CLAUDE_CONFIG_DIR
                ? basename(process.env.CLAUDE_CONFIG_DIR).replace(/^\./, "")
                : null,
            lastToolName: transcriptData.lastToolName,
            payloadEstimate,
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
                ensureCacheDir();
                const triggerFile = sessionCacheFile("compact-requested", sessionKey);
                writeFileSync(triggerFile, JSON.stringify({
                    requestedAt: new Date().toISOString(),
                    contextPercent: context.contextPercent,
                    threshold: config.contextLimitWarning.threshold,
                }));
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
