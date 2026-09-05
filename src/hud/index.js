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
import { tallyLead } from "./token-tally.js";
import { readHudConfig } from "./state.js";
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
    // The payload's five-hour/seven-day figures are live for this frame, so a
    // `stale` flag the API cache earned must not paint them with `*` / `~` —
    // the marker is per fragment, not per bucket. What the cache still
    // contributes (the Opus/Sonnet weekly and `extra:` buckets) may then be up
    // to 15 min old without saying so; their reset countdowns are computed live.
    const merged = {
        ...(usageResult ?? {}),
        rateLimits: {
            ...(usageResult?.rateLimits ?? {}),
            ...stdinRateLimits,
        },
    };
    delete merged.stale;
    return merged;
}
/**
 * Build the sessionHealth data (session duration) from the session start time.
 */
function calculateSessionHealth(sessionStart) {
    const durationMinutes = Math.max(0, Math.floor((Date.now() - sessionStart.getTime()) / 60_000));
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
        // Tail-read the transcript for the last request's usage (feeds ctx:).
        const transcriptData = parseTranscript(resolvedTranscriptPath);
        // Everything cumulative — the token total, the tool/agent/skill counts
        // and the session start — comes from the incremental whole-file tally
        // (token-tally.js), memoized per session so each frame parses only the
        // bytes appended since the last one. A tail read cannot provide these:
        // it truncates on any large transcript and runs backwards as the
        // window slides (measured; see token-tally.js).
        const lead = tallyLead(resolvedTranscriptPath, sessionKey);
        const sessionStart = lead?.sessionStart ?? null;
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
        const sessionTotalTokens = lead?.totalTokens != null
            ? lead.totalTokens + sumSubagentTokens(resolvedTranscriptPath, sessionKey)
            : null;
        // Repo identity and linked-worktree name straight from the payload
        // (`workspace.repo`, `workspace.git_worktree`), so the git elements can
        // skip three of their six subprocesses. `repo` is absent outside a git
        // repo or without an `origin` remote — exactly when the git fallback
        // would find nothing either. The worktree hint is trusted only when
        // `repo` is present: `git_worktree` predates it (2.1.97 vs ≤2.1.233 in
        // the cached payloads here), so any payload carrying `repo` would also
        // carry `git_worktree` inside a linked worktree; an older payload keeps
        // the `git rev-parse` pair.
        const workspace = stdin.workspace && typeof stdin.workspace === "object" ? stdin.workspace : null;
        const repoName = typeof workspace?.repo?.name === "string" && workspace.repo.name.trim()
            ? workspace.repo.name.trim()
            : null;
        const worktreeName = typeof workspace?.git_worktree === "string" && workspace.git_worktree.trim()
            ? workspace.git_worktree.trim()
            : null;
        const worktreeHint = repoName ? { known: true, name: worktreeName } : { known: false, name: null };
        // Build render context
        const context = {
            contextPercent,
            repoName,
            worktreeHint,
            // Threaded through so elements can memoize across renders (the SVN
            // status walk does; one process per render kills in-memory caches).
            sessionKey,
            modelName: getModelName(stdin),
            modelId: getModelId(stdin),
            effortLevel: getEffortLevel(stdin),
            cwd,
            rateLimitsResult,
            // Null without a transcript, so `session:` hides instead of reading 0m.
            sessionHealth: sessionStart ? calculateSessionHealth(sessionStart) : null,
            lastRequestTokenUsage: transcriptData.lastRequestTokenUsage || null,
            sessionTotalTokens,
            toolCallCount: lead?.toolCalls ?? 0,
            agentCallCount: lead?.agentCalls ?? 0,
            skillCallCount: lead?.skillCalls ?? 0,
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
        // One fallback line for the bar; the detail goes to stderr, which
        // statusline.sh keeps as cache/<session>/statusline.err.
        console.log("[HUD] HUD error - check stderr");
        console.error("[HUD Error]", error instanceof Error ? (error.stack || error.message) : error);
    }
}
// Auto-run (unconditional so dynamic import() via statusline.mjs wrapper works correctly)
main();
