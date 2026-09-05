/**
 * HUD - Rate Limits Element
 *
 * Renders 5-hour and weekly rate limit usage display.
 */
import { RESET, fg, gradientColor, PALETTE, paintFaint, paintWarn } from '../colors.js';
// Palette tokens: steel "5h:"/"7d:" labels AND the reset-time parentheticals
// (the latter share the call-count tone, PALETTE.label), faint slate for the
// $spent/$limit parenthetical, and a hairline-slate empty-bar track.
const LABEL = fg(PALETTE.label);
const FAINT = fg(PALETTE.faint);
const TRACK = fg(PALETTE.sep);
/**
 * Get color based on percentage — three-tier palette snap (teal <70 / amber
 * 70–84 / rose ≥85), replacing the old green/yellow/red traffic-light steps.
 */
function getColor(percent) {
    return fg(gradientColor(percent));
}
/**
 * Format reset time as human-readable duration.
 * Returns null if date is null/undefined or in the past.
 */
function formatResetTime(date) {
    if (!date)
        return null;
    const now = Date.now();
    const resetMs = date.getTime();
    const diffMs = resetMs - now;
    // Already reset or invalid
    if (diffMs <= 0)
        return null;
    const diffMinutes = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays > 0) {
        const remainingHours = diffHours % 24;
        return `${diffDays}d${remainingHours}h`;
    }
    const remainingMinutes = diffMinutes % 60;
    return `${diffHours}h${remainingMinutes}m`;
}
/**
 * Render rate limits display.
 *
 * Format: 5h:45%(3h42m) 7d:12%(2d5h) mo:8%(15d3h) sn:20%(1d2h) op:5%(1d2h)
 */
export function renderRateLimits(limits, stale, sonnetThreshold = 0) {
    if (!limits)
        return null;
    const staleMarker = stale ? paintFaint('*') : '';
    const resetPrefix = stale ? '~' : '';
    // One window → faint "5h:" label + gradient percent + faint "(reset)".
    const fmt = (label, percent, resetsAt) => {
        const pct = Math.min(100, Math.max(0, Math.round(percent)));
        const reset = formatResetTime(resetsAt);
        const head = `${LABEL}${label}:${RESET}${getColor(pct)}${pct}%${RESET}${staleMarker}`;
        return reset ? `${head}${LABEL}(${resetPrefix}${reset})${RESET}` : head;
    };
    const parts = [];
    // Every window is optional: a payload can carry one without the other, and
    // the API may have answered with neither. Rendering an absent one would
    // read `5h:NaN%`.
    if (limits.fiveHourPercent != null) {
        parts.push(fmt('5h', limits.fiveHourPercent, limits.fiveHourResetsAt));
    }
    if (limits.weeklyPercent != null) {
        parts.push(fmt('7d', limits.weeklyPercent, limits.weeklyResetsAt));
    }
    if (limits.monthlyPercent != null) {
        parts.push(fmt('mo', limits.monthlyPercent, limits.monthlyResetsAt));
    }
    // Sonnet weekly (sn) is a low-signal bucket for Opus-heavy users (often 0%);
    // only surface it once it approaches its cap (>= sonnetThreshold, 0 = always).
    if (limits.sonnetWeeklyPercent != null && Math.round(limits.sonnetWeeklyPercent) >= sonnetThreshold) {
        parts.push(fmt('sn', limits.sonnetWeeklyPercent, limits.sonnetWeeklyResetsAt));
    }
    if (limits.opusWeeklyPercent != null) {
        parts.push(fmt('op', limits.opusWeeklyPercent, limits.opusWeeklyResetsAt));
    }
    if (limits.extraUsagePercent != null && limits.extraUsageLimitUsd != null) {
        const extra = Math.min(100, Math.max(0, Math.round(limits.extraUsagePercent)));
        const extraReset = formatResetTime(limits.extraUsageResetsAt);
        const dollarPart = `${FAINT}($${(limits.extraUsageSpentUsd ?? 0).toFixed(2)}/$${limits.extraUsageLimitUsd.toFixed(2)})${RESET}`;
        const extraHead = `${LABEL}extra:${RESET}${getColor(extra)}${extra}%${RESET}${staleMarker}${dollarPart}`;
        parts.push(extraReset ? `${extraHead}${LABEL}(${resetPrefix}${extraReset})${RESET}` : extraHead);
    }
    return parts.length > 0 ? parts.join(' ') : null;
}
/**
 * Render rate limits with visual progress bars.
 *
 * Format: 5h:[████░░░░]45%(3h42m) 7d:[█░░░░░░░]12%(2d5h) ...
 */
export function renderRateLimitsWithBar(limits, barWidth = 8, stale, sonnetThreshold = 0) {
    if (!limits)
        return null;
    const staleMarker = stale ? paintFaint('*') : '';
    const resetPrefix = stale ? '~' : '';
    // One window → faint label + gradient block-bar + gradient percent + faint reset.
    const fmt = (label, percent, resetsAt) => {
        const pct = Math.min(100, Math.max(0, Math.round(percent)));
        const color = getColor(pct);
        const filled = Math.round((pct / 100) * barWidth);
        const empty = barWidth - filled;
        const bar = `${color}${'█'.repeat(filled)}${TRACK}${'░'.repeat(empty)}${RESET}`;
        const reset = formatResetTime(resetsAt);
        const head = `${LABEL}${label}:${RESET}[${bar}]${color}${pct}%${RESET}${staleMarker}`;
        return reset ? `${head}${LABEL}(${resetPrefix}${reset})${RESET}` : head;
    };
    const parts = [];
    if (limits.fiveHourPercent != null) {
        parts.push(fmt('5h', limits.fiveHourPercent, limits.fiveHourResetsAt));
    }
    if (limits.weeklyPercent != null) {
        parts.push(fmt('7d', limits.weeklyPercent, limits.weeklyResetsAt));
    }
    if (limits.monthlyPercent != null) {
        parts.push(fmt('mo', limits.monthlyPercent, limits.monthlyResetsAt));
    }
    // Sonnet weekly (sn) is a low-signal bucket for Opus-heavy users (often 0%);
    // only surface it once it approaches its cap (>= sonnetThreshold, 0 = always).
    if (limits.sonnetWeeklyPercent != null && Math.round(limits.sonnetWeeklyPercent) >= sonnetThreshold) {
        parts.push(fmt('sn', limits.sonnetWeeklyPercent, limits.sonnetWeeklyResetsAt));
    }
    if (limits.opusWeeklyPercent != null) {
        parts.push(fmt('op', limits.opusWeeklyPercent, limits.opusWeeklyResetsAt));
    }
    if (limits.extraUsagePercent != null && limits.extraUsageLimitUsd != null) {
        const extra = Math.min(100, Math.max(0, Math.round(limits.extraUsagePercent)));
        const color = getColor(extra);
        const filled = Math.round((extra / 100) * barWidth);
        const empty = barWidth - filled;
        const bar = `${color}${'█'.repeat(filled)}${TRACK}${'░'.repeat(empty)}${RESET}`;
        const extraReset = formatResetTime(limits.extraUsageResetsAt);
        const dollarPart = `${FAINT}($${(limits.extraUsageSpentUsd ?? 0).toFixed(2)}/$${limits.extraUsageLimitUsd.toFixed(2)})${RESET}`;
        const head = `${LABEL}extra:${RESET}[${bar}]${color}${extra}%${RESET}${staleMarker}${dollarPart}`;
        parts.push(extraReset ? `${head}${LABEL}(${resetPrefix}${extraReset})${RESET}` : head);
    }
    return parts.length > 0 ? parts.join(' ') : null;
}
/**
 * Render an error indicator when the built-in rate limit API call fails.
 *
 * - 'network': API timeout, HTTP error, or parse failure → [API err]
 * - 'auth': credentials expired, refresh failed → [API auth]
 * - 'no_credentials': no OAuth credentials (expected for API key users) → null (no display)
 */
export function renderRateLimitsError(result) {
    if (!result?.error)
        return null;
    if (result.error === 'no_credentials')
        return null;
    if (result.error === 'rate_limited') {
        // Prefer rendering stale usage percentages when available; only show the 429 badge
        // when there is no cached rate limit data to display.
        return result.rateLimits ? null : paintFaint('[API 429]');
    }
    if (result.error === 'auth')
        return paintWarn('[API auth]');
    return paintWarn('[API err]');
}
