/**
 * HUD - Prompt Cache Element
 *
 * Renders the payload's `prompt_cache` state.
 */
import { DEFAULT_HUD_LABELS } from '../types.js';
import { paint, paintLabel, PALETTE } from '../colors.js';
import { formatClockTime, formatTokenCount } from '../../lib/formatting.js';
/**
 * Render the main conversation's prompt cache.
 *
 * Format: cache:warm(14:30) · cache:cold(161.8k)
 *
 * Warm shows the local time the cached prefix goes cold (`expires_at`, floored
 * to the minute so it never reads later than the truth) — a clock time, not a
 * countdown, because without `refreshInterval` Claude Code re-runs the command
 * only on events, and an idle session is exactly when the cache is about to go
 * cold: a countdown would sit frozen at `59m`, a clock time stays right.
 * Cold shows `recache_tokens_if_cold` — what the next request will write to
 * the cache again, the cost of having let it go cold — when the payload has it.
 *
 * A frame whose `expires_at` has passed renders cold even if its `warm` still
 * says true: the wrapper can serve a line rendered before the expiry, and the
 * payload's `warm` is a snapshot from when Claude Code built it.
 *
 * Calm tier for warm, watch tier for cold (the next request costs more), so
 * the colors read like the gauges beside them.
 */
export function renderPromptCache(cache, labels = DEFAULT_HUD_LABELS, nowMs = Date.now()) {
    if (!cache)
        return null;
    const expiresMs = cache.expiresAt ? cache.expiresAt.getTime() : NaN;
    const hasExpiry = Number.isFinite(expiresMs);
    const head = paintLabel(`${labels.promptCache}:`);
    if (cache.warm && (!hasExpiry || expiresMs > nowMs)) {
        const until = hasExpiry ? paintLabel(`(${formatClockTime(expiresMs)})`) : '';
        return `${head}${paint(PALETTE.gradLow, labels.cacheWarm)}${until}`;
    }
    const cost = cache.recacheTokens ? paintLabel(`(${formatTokenCount(cache.recacheTokens)})`) : '';
    return `${head}${paint(PALETTE.gradMid, labels.cacheCold)}${cost}`;
}
