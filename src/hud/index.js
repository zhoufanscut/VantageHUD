#!/usr/bin/env node
/**
 * HUD - Main Entry Point
 *
 * Statusline command that renders the VantageHUD status line.
 * Receives stdin JSON from Claude Code and outputs formatted statusline.
 */
import { readStdin, writeStdinCache, readStdinCache, getContextPercent, getContextPercentFromUsage, getModelId, getModelName, getEffortLevel, getRateLimitsFromStdin, getSpendLimitFromStdin, getNextTimedTrigger, getPromptCache, stabilizeContextPercent, } from "./stdin.js";
import { parseTranscript } from "./transcript.js";
import { sumSubagentTokens } from "./subagents.js";
import { tallyLead } from "./token-tally.js";
import { readHudConfig } from "./state.js";
import { getUsage } from "./usage-api.js";
import { render } from "./render.js";
import { sanitizeOutput } from "./sanitize.js";
import { resolveToWorktreeRoot, resolveTranscriptPath } from "../lib/worktree-paths.js";
import { unlinkSync } from "fs";
import { atomicTouchSync, atomicWriteFileSync } from "../lib/atomic-write.js";
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
    // A blank or non-string candidate falls through to the next one, so the
    // key is never whitespace (sanitizeSessionKey would turn that into
    // `default` for the folder while the raw value went elsewhere).
    const usable = (value) => (typeof value === "string" && value.trim() ? value : null);
    return (usable(process.env.HUD_SESSION_KEY)
        || usable(stdin?.session_id)
        || usable(process.env.CLAUDE_CODE_SESSION_ID)
        || usable(process.env.CLAUDE_SESSION_ID)
        || usable(process.env.CLAUDECODE_SESSION_ID)
        || extractSessionIdFromPath(typeof stdin?.transcript_path === "string" ? stdin.transcript_path : "")
        || "default");
}
function mergeStdinRateLimits(stdinRateLimits, usageResult) {
    if (!stdinRateLimits) {
        return usageResult;
    }
    // The payload's five-hour/seven-day figures are live for this frame, so a
    // `stale` flag the API cache earned must not paint them with `*` / `~` —
    // the marker is per fragment, not per bucket. What the cache still
    // contributes (the per-model weekly and `extra:` buckets) may then be up
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
        if (!stdin || typeof stdin !== "object" || Array.isArray(stdin)) {
            // No piped stdin (e.g. invoked directly), or not a payload object —
            // nothing to render.
            return;
        }
        const sessionKey = resolveSessionKey(stdin);
        // Carry the previous frame's context% across Claude Code's transient
        // all-null context_window snapshots. The cache is per-session, so other
        // sessions in this directory can no longer clobber it.
        const previousStdinCache = readStdinCache(sessionKey);
        stdin = stabilizeContextPercent(stdin, previousStdinCache);
        writeStdinCache(stdin, sessionKey);
        // Claude Code sends strings; anything else is treated as absent rather
        // than reaching path.resolve / fs calls that throw on it.
        const cwd = resolveToWorktreeRoot(typeof stdin.cwd === "string" && stdin.cwd ? stdin.cwd : undefined);
        // Read configuration.
        // Clone to avoid mutating shared DEFAULT_HUD_CONFIG when applying runtime width detection
        const config = { ...readHudConfig() };
        // Auto-detect the terminal width when maxWidth is not configured.
        // Prefer live TTY columns over the COLUMNS env var (which the statusline
        // docs say Claude Code sets, though a live 2.1.261 hook had none). The
        // configured wrapMode is honored as is — truncate by default, so the
        // HUD stays one line; set "wrap" to break at separators instead.
        if (config.maxWidth === undefined) {
            const cols = process.stderr.columns ||
                process.stdout.columns ||
                parseInt(process.env.COLUMNS ?? "0", 10) ||
                0;
            if (cols > 0) {
                config.maxWidth = cols;
            }
        }
        // Resolve worktree-mismatched transcript paths (oh-my-claudecode#1094)
        const resolvedTranscriptPath = resolveTranscriptPath(typeof stdin.transcript_path === "string" ? stdin.transcript_path : undefined, cwd);
        // Everything cumulative — the token total, the tool/agent/skill/workflow counts
        // and the session start — comes from the incremental whole-file tally
        // (token-tally.js), memoized per session so each frame parses only the
        // bytes appended since the last one. A tail read cannot provide these:
        // it truncates on any large transcript and runs backwards as the
        // window slides (measured; see token-tally.js).
        const lead = tallyLead(resolvedTranscriptPath, sessionKey);
        const sessionStart = lead?.sessionStart ?? null;
        // Merge Claude Code stdin generic buckets with API/cache-specific fields.
        // Stdin owns fresher five-hour/seven-day values, while getUsage() may provide
        // the per-model weekly and extra buckets, stale, and error metadata.
        const stdinRateLimits = getRateLimitsFromStdin(stdin);
        // statusline.sh sets HUD_SYNC_RENDER=1 and HUD_USAGE_BUDGET_MS only for
        // a synchronous render, which Claude Code is waiting on: there the slow
        // work — the usage API, the `svn status` walk — must not run long.
        // Background refreshes do it unbudgeted and keep their caches fresh.
        const syncRender = process.env.HUD_SYNC_RENDER === "1";
        const usageBudgetMs = parseInt(process.env.HUD_USAGE_BUDGET_MS ?? "", 10) || 0;
        // A synchronous render whose payload already carries both windows does
        // not wait on the API at all: what a fetch would add (the per-model
        // weekly and extra: buckets) is not worth up to the whole budget on
        // the frame Claude Code is waiting for, and the next background
        // refresh fetches it. A payload missing either window — a fresh
        // session's first frame has none — still fetches, budgeted.
        const usageCacheOnly = syncRender &&
            stdinRateLimits?.fiveHourPercent != null &&
            stdinRateLimits?.weeklyPercent != null;
        const usageResult = config.elements.rateLimits === false
            ? null
            : await getUsage({ budgetMs: usageBudgetMs, cacheOnly: usageCacheOnly });
        const rateLimitsResult = config.elements.rateLimits === false
            ? null
            : mergeStdinRateLimits(stdinRateLimits, usageResult);
        // Native stdin context_window is authoritative when present, but Claude
        // Code zeroes it between turns and non-Anthropic providers (API token +
        // ANTHROPIC_BASE_URL) leave it zeroed far more often. When it yields 0,
        // recover the value from the transcript's last-request usage so ctx does
        // not collapse to 0% on idle frames or after a cross-session cache clobber.
        // The transcript tail is read only here: on every other frame its
        // result would go unused.
        let contextPercent = getContextPercent(stdin);
        if (contextPercent === 0) {
            const { lastRequestTokenUsage } = parseTranscript(resolvedTranscriptPath);
            const contextFromUsage = getContextPercentFromUsage(stdin, lastRequestTokenUsage);
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
        // `approximate` marks a total that is known to run low: some call's
        // usage never settled (most subagent calls from Claude Code 2.1.283).
        let sessionTotalTokens = null;
        let sessionTokensApproximate = false;
        if (lead?.totalTokens != null) {
            const team = sumSubagentTokens(resolvedTranscriptPath, sessionKey);
            sessionTotalTokens = lead.totalTokens + team.total;
            sessionTokensApproximate = lead.approximate || team.approximate;
        }
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
            // Threaded through so elements can memoize across renders (the git
            // and SVN status walks do; one process per render kills in-memory
            // caches).
            sessionKey,
            // A synchronous render serves the status memo instead of walking
            // (git still walks a repository not yet known to be slow).
            syncRender,
            modelName: getModelName(stdin),
            modelId: getModelId(stdin),
            effortLevel: getEffortLevel(stdin),
            cwd,
            rateLimitsResult,
            // Null without a transcript, so `session:` hides instead of reading 0m.
            sessionHealth: sessionStart ? calculateSessionHealth(sessionStart) : null,
            sessionTotalTokens,
            sessionTokensApproximate,
            toolCallCount: lead?.toolCalls ?? 0,
            agentCallCount: lead?.agentCalls ?? 0,
            skillCallCount: lead?.skillCalls ?? 0,
            // Shown only with `elements.workflowRuns` on.
            workflowRunCount: lead?.workflowRuns ?? 0,
            promptCache: getPromptCache(stdin),
            // `rate_limits.spend_limit` (Claude apps gateway); shown only with
            // `elements.spendLimit` on. Read from the payload alone: the usage
            // API is skipped behind a gateway.
            spendLimit: getSpendLimitFromStdin(stdin),
        };
        // Debug: log data if HUD_DEBUG is set
        if (process.env.HUD_DEBUG) {
            console.error("[HUD DEBUG] stdin.context_window:", JSON.stringify(stdin.context_window));
            console.error("[HUD DEBUG] sessionHealth:", JSON.stringify(context.sessionHealth));
        }
        // Render and output
        let output = await render(context, config);
        // Apply safe mode sanitization if enabled (oh-my-claudecode#346)
        // This strips ANSI codes and uses ASCII-only output to prevent
        // terminal rendering corruption during concurrent updates.
        // mergeWithDefaults always supplies safeMode (default true), so only the
        // user's value decides. Explicit `false` turns it off everywhere; the
        // win32 clause matters only for a falsy non-false value (null, 0),
        // which keeps safe mode on Windows and turns it off elsewhere.
        const useSafeMode = config.elements.safeMode !== false &&
            (config.elements.safeMode || process.platform === "win32");
        const line = useSafeMode
            // In safe mode, use regular spaces (don't convert to non-breaking)
            ? sanitizeOutput(output)
            // Replace spaces with non-breaking spaces for terminal alignment
            : output.replace(/ /g, "\u00A0");
        // statusline.sh names its cached line in HUD_OUTPUT_FILE. Writing it
        // here, the moment the line exists, means a wrapper killed while still
        // waiting on this process (Claude Code cancels an in-flight statusLine
        // command when a new trigger fires) can no longer lose a finished
        // render — without a cached line every frame takes the slow
        // synchronous path again. Only good lines: a "[HUD] ..." fallback is
        // the wrapper's to keep or not.
        if (process.env.HUD_OUTPUT_FILE) {
            try {
                atomicWriteFileSync(process.env.HUD_OUTPUT_FILE, `${line}\n`);
            }
            catch (error) {
                if (process.env.HUD_DEBUG) {
                    console.error("[HUD] Output cache write error:", error instanceof Error ? error.message : error);
                }
            }
        }
        // statusline.sh's HUD_DEADLINE_FILE: an empty file whose mtime is the
        // next time trigger in this payload (a rate-limit reset, a prompt-cache
        // expiry) less a second — the slack keeps a trigger that fires a little
        // early, or a shell whose `-ot` compares whole seconds, from missing
        // it. Once it has passed, the wrapper renders that frame synchronously
        // instead of serving the line cached before it. Absent when there is
        // no future trigger.
        if (process.env.HUD_DEADLINE_FILE) {
            try {
                const next = getNextTimedTrigger(stdin, Date.now());
                if (next != null) {
                    atomicTouchSync(process.env.HUD_DEADLINE_FILE, Math.floor(next / 1000) - 1);
                }
                else {
                    unlinkSync(process.env.HUD_DEADLINE_FILE);
                }
            }
            catch (error) {
                if (process.env.HUD_DEBUG && error?.code !== "ENOENT") {
                    console.error("[HUD] Deadline file write error:", error instanceof Error ? error.message : error);
                }
            }
        }
        console.log(line);
        // An abandoned usage request can keep the process alive past the
        // budget — through a proxy, the pending CONNECT holds the event loop
        // for its own 10 s timeout (measured). The wrapper waits for exit, so
        // a synchronous render leaves as soon as its line is flushed. Nothing
        // else is pending by then: every cache write above is synchronous.
        if (syncRender || usageBudgetMs > 0) {
            process.stdout.write("", () => process.exit(0));
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
