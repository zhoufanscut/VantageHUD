/**
 * HUD - Rate Limits Element
 *
 * Renders 5-hour and weekly rate limit usage display (built-in providers),
 * and custom rate limit buckets from the rateLimitsProvider command.
 */
import { RESET, fg, gradientColor, AURORA } from '../colors.js';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
// Aurora colors only: faint slate for "5h:" / "7d:" labels and reset parentheticals.
const LABEL = fg(AURORA.label);
const FAINT = fg(AURORA.faint);
/**
 * Get color based on percentage — Aurora smooth gradient (teal→amber→rose),
 * replacing the old green/yellow/red traffic-light steps.
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
export function renderRateLimits(limits, stale) {
    if (!limits)
        return null;
    const staleMarker = stale ? `${DIM}*${RESET}` : '';
    const resetPrefix = stale ? '~' : '';
    // One window → faint "5h:" label + gradient percent + faint "(reset)".
    const fmt = (label, percent, resetsAt) => {
        const pct = Math.min(100, Math.max(0, Math.round(percent)));
        const reset = formatResetTime(resetsAt);
        const head = `${LABEL}${label}:${RESET}${getColor(pct)}${pct}%${RESET}${staleMarker}`;
        return reset ? `${head}${FAINT}(${resetPrefix}${reset})${RESET}` : head;
    };
    const parts = [fmt('5h', limits.fiveHourPercent, limits.fiveHourResetsAt)];
    if (limits.weeklyPercent != null) {
        parts.push(fmt('7d', limits.weeklyPercent, limits.weeklyResetsAt));
    }
    if (limits.monthlyPercent != null) {
        parts.push(fmt('mo', limits.monthlyPercent, limits.monthlyResetsAt));
    }
    if (limits.sonnetWeeklyPercent != null) {
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
        parts.push(extraReset ? `${extraHead}${FAINT}(${resetPrefix}${extraReset})${RESET}` : extraHead);
    }
    return parts.join(' ');
}
/**
 * Render compact rate limits (just percentages).
 *
 * Format: 45%/12% or 45%/12%/8%/20%/5% (5h/7d/mo/sn/op)
 */
export function renderRateLimitsCompact(limits, stale) {
    if (!limits)
        return null;
    const fiveHour = Math.min(100, Math.max(0, Math.round(limits.fiveHourPercent)));
    const fiveHourColor = getColor(fiveHour);
    const parts = [`${fiveHourColor}${fiveHour}%${RESET}`];
    if (limits.weeklyPercent != null) {
        const weekly = Math.min(100, Math.max(0, Math.round(limits.weeklyPercent)));
        const weeklyColor = getColor(weekly);
        parts.push(`${weeklyColor}${weekly}%${RESET}`);
    }
    if (limits.monthlyPercent != null) {
        const monthly = Math.min(100, Math.max(0, Math.round(limits.monthlyPercent)));
        const monthlyColor = getColor(monthly);
        parts.push(`${monthlyColor}${monthly}%${RESET}`);
    }
    if (limits.sonnetWeeklyPercent != null) {
        const sonnet = Math.min(100, Math.max(0, Math.round(limits.sonnetWeeklyPercent)));
        const sonnetColor = getColor(sonnet);
        parts.push(`${sonnetColor}${sonnet}%${RESET}`);
    }
    if (limits.opusWeeklyPercent != null) {
        const opus = Math.min(100, Math.max(0, Math.round(limits.opusWeeklyPercent)));
        const opusColor = getColor(opus);
        parts.push(`${opusColor}${opus}%${RESET}`);
    }
    if (limits.extraUsagePercent != null && limits.extraUsageLimitUsd != null) {
        const extra = Math.min(100, Math.max(0, Math.round(limits.extraUsagePercent)));
        const extraColor = getColor(extra);
        parts.push(`${extraColor}${extra}%${RESET}`);
    }
    const result = parts.join('/');
    return stale ? `${result}${DIM}*${RESET}` : result;
}
/**
 * Render rate limits with visual progress bars.
 *
 * Format: 5h:[████░░░░]45%(3h42m) 7d:[█░░░░░░░]12%(2d5h) ...
 */
export function renderRateLimitsWithBar(limits, barWidth = 8, stale) {
    if (!limits)
        return null;
    const staleMarker = stale ? `${DIM}*${RESET}` : '';
    const resetPrefix = stale ? '~' : '';
    // One window → faint label + gradient block-bar + gradient percent + faint reset.
    const fmt = (label, percent, resetsAt) => {
        const pct = Math.min(100, Math.max(0, Math.round(percent)));
        const color = getColor(pct);
        const filled = Math.round((pct / 100) * barWidth);
        const empty = barWidth - filled;
        const bar = `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
        const reset = formatResetTime(resetsAt);
        const head = `${LABEL}${label}:${RESET}[${bar}]${color}${pct}%${RESET}${staleMarker}`;
        return reset ? `${head}${FAINT}(${resetPrefix}${reset})${RESET}` : head;
    };
    const parts = [fmt('5h', limits.fiveHourPercent, limits.fiveHourResetsAt)];
    if (limits.weeklyPercent != null) {
        parts.push(fmt('7d', limits.weeklyPercent, limits.weeklyResetsAt));
    }
    if (limits.monthlyPercent != null) {
        parts.push(fmt('mo', limits.monthlyPercent, limits.monthlyResetsAt));
    }
    if (limits.sonnetWeeklyPercent != null) {
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
        const bar = `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
        const extraReset = formatResetTime(limits.extraUsageResetsAt);
        const dollarPart = `${FAINT}($${(limits.extraUsageSpentUsd ?? 0).toFixed(2)}/$${limits.extraUsageLimitUsd.toFixed(2)})${RESET}`;
        const head = `${LABEL}extra:${RESET}[${bar}]${color}${extra}%${RESET}${staleMarker}${dollarPart}`;
        parts.push(extraReset ? `${head}${FAINT}(${resetPrefix}${extraReset})${RESET}` : head);
    }
    return parts.join(' ');
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
        return result.rateLimits ? null : `${DIM}[API 429]${RESET}`;
    }
    if (result.error === 'auth')
        return `${YELLOW}[API auth]${RESET}`;
    return `${YELLOW}[API err]${RESET}`;
}
// ============================================================================
// Custom provider bucket rendering
// ============================================================================
/**
 * Compute a 0-100 usage percentage for threshold checks.
 * Returns null for string usage (no numeric basis).
 */
function bucketUsagePercent(usage) {
    if (usage.type === 'percent')
        return usage.value;
    if (usage.type === 'credit' && usage.limit > 0)
        return (usage.used / usage.limit) * 100;
    return null;
}
/**
 * Render a bucket usage value as a display string.
 *   percent  → "32%"
 *   credit   → "250/300"
 *   string   → value as-is
 */
function renderBucketUsageValue(usage) {
    if (usage.type === 'percent')
        return `${Math.round(usage.value)}%`;
    if (usage.type === 'credit')
        return `${usage.used}/${usage.limit}`;
    return usage.value;
}
/**
 * Render custom rate limit buckets from the rateLimitsProvider command.
 *
 * Format (normal):  label:32%  label2:250/300  label3:as-is
 * Format (stale):   label:32%*  (asterisk marks stale/cached data)
 * Format (error):   [cmd:err]
 *
 * resetsAt is shown only when usage exceeds thresholdPercent (default 85).
 */
export function renderCustomBuckets(result, thresholdPercent = 85) {
    // Command failed and no cached data
    if (result.error && result.buckets.length === 0) {
        return `${YELLOW}[cmd:err]${RESET}`;
    }
    if (result.buckets.length === 0)
        return null;
    const staleMarker = result.stale ? `${DIM}*${RESET}` : '';
    const parts = result.buckets.map((bucket) => {
        const pct = bucketUsagePercent(bucket.usage);
        const color = pct != null ? getColor(pct) : '';
        const colorReset = pct != null ? RESET : '';
        const usageStr = renderBucketUsageValue(bucket.usage);
        // Show resetsAt only above threshold (string usage never shows it)
        let resetPart = '';
        if (bucket.resetsAt && pct != null && pct >= thresholdPercent) {
            const d = new Date(bucket.resetsAt);
            if (!isNaN(d.getTime())) {
                const str = formatResetTime(d);
                if (str)
                    resetPart = `${FAINT}(${str})${RESET}`;
            }
        }
        return `${LABEL}${bucket.label}:${RESET}${color}${usageStr}${colorReset}${staleMarker}${resetPart}`;
    });
    return parts.join(' ');
}
//# sourceMappingURL=limits.js.map
