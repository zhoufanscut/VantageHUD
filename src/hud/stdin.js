/**
 * HUD - Stdin Parser
 *
 * Parse stdin JSON from Claude Code statusline interface.
 * Based on claude-hud reference implementation.
 */
import { readFileSync, writeFileSync } from 'fs';
import { ensureSessionCacheDir, sessionCacheFile, listSessionCacheFiles, } from '../lib/worktree-paths.js';
const TRANSIENT_CONTEXT_PERCENT_TOLERANCE = 3;
// ============================================================================
// Stdin Cache (session-scoped, in the session's cache subfolder)
// ============================================================================
/**
 * Persist the last successful stdin read, keyed by session.
 *
 * Written to `<cacheDir>/<session>/hud-stdin-cache.json`. The session key is
 * supplied by the caller (derived from the stdin `session_id`), so the cache is
 * per-session by construction — concurrent sessions in the same directory can
 * no longer clobber each other's stabilization snapshot.
 */
export function writeStdinCache(stdin, sessionKey) {
    try {
        ensureSessionCacheDir(sessionKey);
        writeFileSync(sessionCacheFile('hud-stdin-cache', sessionKey), JSON.stringify(stdin));
    }
    catch {
        // Best-effort; ignore failures
    }
}
/**
 * Read the cached stdin JSON for a session.
 *
 * With a session key, the per-session file is authoritative. Without one (e.g.
 * a detached watch process that never received the stdin payload), fall back to
 * the most recently modified `<session>/hud-stdin-cache.json` so the view is not
 * stuck empty. Returns null if no cache exists or it is unreadable.
 */
export function readStdinCache(sessionKey) {
    const tryRead = (path) => {
        if (!path)
            return null;
        try {
            return JSON.parse(readFileSync(path, 'utf-8'));
        }
        catch {
            // Missing/unreadable cache — treat as no previous snapshot.
            return null;
        }
    };
    if (sessionKey != null && String(sessionKey).trim() !== '') {
        return tryRead(sessionCacheFile('hud-stdin-cache', sessionKey));
    }
    // Env-less reader: surface the most recent session's cache.
    const [mostRecent] = listSessionCacheFiles('hud-stdin-cache');
    return tryRead(mostRecent ?? null);
}
// ============================================================================
// Stdin Reader
// ============================================================================
/**
 * Read and parse stdin JSON from Claude Code.
 * Returns null if stdin is not available or invalid.
 */
export async function readStdin() {
    // Skip if running in TTY mode (interactive terminal)
    if (process.stdin.isTTY) {
        return null;
    }
    const chunks = [];
    try {
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        const raw = chunks.join('');
        if (!raw.trim()) {
            return null;
        }
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function getCurrentUsage(stdin) {
    return stdin.context_window?.current_usage;
}
function clampPercent(value) {
    if (value == null || !isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(100, value));
}
function parseResetDate(value) {
    if (value == null) {
        return null;
    }
    const numericValue = typeof value === 'number'
        ? value
        : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);
    if (Number.isFinite(numericValue)) {
        const millis = Math.abs(numericValue) < 1e12 ? numericValue * 1000 : numericValue;
        const date = new Date(millis);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value === 'string') {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
}
/**
 * Get total tokens from stdin context_window.current_usage
 */
function getTotalTokens(stdin) {
    const usage = getCurrentUsage(stdin);
    return ((usage?.input_tokens ?? 0) +
        (usage?.cache_creation_input_tokens ?? 0) +
        (usage?.cache_read_input_tokens ?? 0));
}
function getTotalInputTokens(stdin) {
    return stdin.context_window?.total_input_tokens ?? 0;
}
function getRoundedNativeContextPercent(stdin) {
    const nativePercent = stdin?.context_window?.used_percentage;
    if (typeof nativePercent !== 'number' || Number.isNaN(nativePercent)) {
        return null;
    }
    return Math.min(100, Math.max(0, Math.round(nativePercent)));
}
function getPositiveNativeContextPercent(stdin) {
    const nativePercent = stdin?.context_window?.used_percentage;
    if (typeof nativePercent !== 'number' || Number.isNaN(nativePercent) || nativePercent <= 0) {
        return null;
    }
    return Math.min(100, Math.max(0, Math.round(nativePercent)));
}
function getManualContextPercent(stdin) {
    const size = stdin.context_window?.context_window_size;
    if (!size || size <= 0) {
        return null;
    }
    const totalTokens = getTotalTokens(stdin);
    return Math.min(100, Math.round((totalTokens / size) * 100));
}
function getPositiveManualContextPercent(stdin) {
    const manualPercent = getManualContextPercent(stdin);
    return manualPercent !== null && manualPercent > 0 ? manualPercent : null;
}
function getTotalInputContextPercent(stdin) {
    const size = stdin.context_window?.context_window_size;
    if (!size || size <= 0) {
        return null;
    }
    const totalInputTokens = getTotalInputTokens(stdin);
    if (totalInputTokens <= 0) {
        return null;
    }
    return Math.min(100, Math.round((totalInputTokens / size) * 100));
}
function isSameContextStream(current, previous) {
    return current.cwd === previous.cwd
        && current.transcript_path === previous.transcript_path
        && current.context_window?.context_window_size === previous.context_window?.context_window_size;
}
/**
 * Preserve the last native context percentage across transient snapshots where Claude Code
 * omits `used_percentage`, but only when the fallback calculation is close enough to suggest
 * the same underlying value rather than a real context jump.
 */
export function stabilizeContextPercent(stdin, previousStdin) {
    if (getPositiveNativeContextPercent(stdin) !== null) {
        return stdin;
    }
    if (!previousStdin || !isSameContextStream(stdin, previousStdin)) {
        return stdin;
    }
    const previousNativePercent = getRoundedNativeContextPercent(previousStdin);
    if (previousNativePercent === null) {
        return stdin;
    }
    const fallbackPercent = getPositiveManualContextPercent(stdin) ?? getTotalInputContextPercent(stdin);
    if (fallbackPercent === null && getRoundedNativeContextPercent(stdin) === 0) {
        return stdin;
    }
    if (fallbackPercent !== null
        && Math.abs(fallbackPercent - previousNativePercent) > TRANSIENT_CONTEXT_PERCENT_TOLERANCE) {
        return stdin;
    }
    return {
        ...stdin,
        context_window: {
            ...stdin.context_window,
            used_percentage: previousStdin.context_window?.used_percentage ?? previousNativePercent,
        },
    };
}
/**
 * Get context window usage percentage.
 * Prefers a positive native percentage from Claude Code statusline stdin,
 * then positive current_usage tokens, then positive total_input_tokens for
 * Anthropic-compatible providers that report zeroed native usage.
 */
export function getContextPercent(stdin) {
    return (getPositiveNativeContextPercent(stdin)
        ?? getPositiveManualContextPercent(stdin)
        ?? getTotalInputContextPercent(stdin)
        ?? 0);
}
/**
 * Last-resort context percentage derived from the transcript's last-request
 * token usage. Used only when the live stdin `context_window` yields nothing.
 *
 * Claude Code emits all-null `context_window` frames between turns, so the HUD
 * normally relies on `stabilizeContextPercent` to carry the previous percentage
 * across them. That bridge fails in two situations that are common with an API
 * token + a non-Anthropic model reached via ANTHROPIC_BASE_URL:
 *   1. the stdin cache is shared per-worktree (Claude Code does not export a
 *      session id, so the cache is not session-scoped); a concurrent/interleaved
 *      session in the same directory clobbers it, and `isSameContextStream`
 *      then rejects the foreign snapshot, leaving nothing to carry forward; and
 *   2. the first frame after a resume has no prior snapshot at all.
 * In both cases ctx collapses to 0 even though the conversation is non-empty.
 *
 * The transcript persists the real last-request usage regardless of the
 * transient stdin frame, so it recovers the value. We sum the input-side
 * tokens (input + cache creation + cache read) to mirror Claude Code's native
 * `total_input_tokens` metric, divided by the live `context_window_size`
 * (which stays populated even in the zeroed frames). Returns null when either
 * the window size or the usage is unavailable.
 */
export function getContextPercentFromUsage(stdin, usage) {
    const size = stdin?.context_window?.context_window_size;
    if (!size || size <= 0 || !usage) {
        return null;
    }
    const contextTokens = (usage.inputTokens ?? 0)
        + (usage.cacheCreationInputTokens ?? 0)
        + (usage.cacheReadInputTokens ?? 0);
    if (contextTokens <= 0) {
        return null;
    }
    return Math.min(100, Math.max(0, Math.round((contextTokens / size) * 100)));
}
/**
 * Convert Claude Code stdin rate_limits into the existing HUD RateLimits shape.
 */
export function getRateLimitsFromStdin(stdin) {
    const fiveHour = stdin.rate_limits?.five_hour?.used_percentage;
    const sevenDay = stdin.rate_limits?.seven_day?.used_percentage;
    if (fiveHour == null && sevenDay == null) {
        return null;
    }
    return {
        fiveHourPercent: clampPercent(fiveHour),
        weeklyPercent: sevenDay == null ? undefined : clampPercent(sevenDay),
        fiveHourResetsAt: parseResetDate(stdin.rate_limits?.five_hour?.resets_at),
        weeklyResetsAt: parseResetDate(stdin.rate_limits?.seven_day?.resets_at),
    };
}
/**
 * Get model display name from stdin.
 * Prefer the official display name field, then fall back to the raw model id.
 * Returns null when Claude Code does not provide model metadata so the HUD
 * omits the model instead of guessing or showing a fake placeholder.
 */
export function getModelId(stdin) {
    const modelId = stdin.model?.id?.trim();
    return modelId || null;
}
export function getModelName(stdin) {
    const displayName = stdin.model?.display_name?.trim();
    return displayName || getModelId(stdin);
}
export function getEffortLevel(stdin) {
    const level = stdin.effort?.level;
    return typeof level === 'string' && level.length > 0 ? level : null;
}
