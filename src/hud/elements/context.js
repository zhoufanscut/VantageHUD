/**
 * HUD - Context Element
 *
 * Renders context window usage display.
 */
import { DEFAULT_HUD_LABELS } from '../types.js';
import { RESET, fg, gradientColor, paintLabel, PALETTE } from '../colors.js';
const TRACK = fg(PALETTE.sep);
function clampContextPercent(percent) {
    return Math.min(100, Math.max(0, Math.round(percent)));
}
function getContextSeverity(safePercent, thresholds) {
    if (safePercent >= thresholds.contextCritical) {
        return 'critical';
    }
    if (safePercent >= thresholds.contextCompactSuggestion) {
        return 'compact';
    }
    if (safePercent >= thresholds.contextWarning) {
        return 'warning';
    }
    return 'normal';
}
/**
 * Color cut points from the configured thresholds: amber from contextWarning,
 * rose from contextCritical — so the color flips in step with the CRITICAL
 * suffix, whatever the user set. A value that is not a finite number takes
 * its default (70 / 85); a warning above critical is capped at critical.
 */
const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
function contextTierBounds(thresholds) {
    const warn = num(thresholds?.contextWarning, 70);
    const crit = num(thresholds?.contextCritical, 85);
    return [Math.min(warn, crit), crit];
}
function getContextDisplayStyle(safePercent, thresholds, labels) {
    // The color snaps across three tiers (teal/amber/rose by default) at
    // contextWarning/contextCritical (70/85 by default); the text suffix adds
    // COMPRESS? from contextCompactSuggestion and CRITICAL from contextCritical.
    const severity = getContextSeverity(safePercent, thresholds);
    const color = fg(gradientColor(safePercent, contextTierBounds(thresholds)));
    switch (severity) {
        case 'critical':
            return { color, suffix: ` ${labels.critical}` };
        case 'compact':
            return { color, suffix: ` ${labels.compress}` };
        default:
            // 'warning' and 'normal': the color alone tells them apart.
            return { color, suffix: '' };
    }
}
/**
 * Render context window percentage.
 *
 * Format: ctx:67%
 *
 * Frame-to-frame jitter damping happens upstream in stabilizeContextPercent
 * (stdin.js), which persists across renders via the per-session stdin cache —
 * in-process state cannot survive the one-process-per-render architecture.
 */
export function renderContext(percent, thresholds, labels = DEFAULT_HUD_LABELS) {
    const safePercent = clampContextPercent(percent);
    const { color, suffix } = getContextDisplayStyle(safePercent, thresholds, labels);
    return `${paintLabel(`${labels.context}:`)}${color}${safePercent}%${suffix}${RESET}`;
}
/**
 * Render context window with visual bar.
 *
 * Format: ctx:[████░░░░░░]67%
 */
export function renderContextWithBar(percent, thresholds, barWidth = 10, labels = DEFAULT_HUD_LABELS) {
    const safePercent = clampContextPercent(percent);
    const filled = Math.round((safePercent / 100) * barWidth);
    const empty = barWidth - filled;
    const { color, suffix } = getContextDisplayStyle(safePercent, thresholds, labels);
    const bar = `${color}${'█'.repeat(filled)}${TRACK}${'░'.repeat(empty)}${RESET}`;
    return `${paintLabel(`${labels.context}:`)}[${bar}]${color}${safePercent}%${suffix}${RESET}`;
}
