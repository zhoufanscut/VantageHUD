/**
 * HUD - Context Element
 *
 * Renders context window usage display.
 */
import { DEFAULT_HUD_LABELS } from '../types.js';
import { RESET, fg, gradientColor, auroraLabel, AURORA } from '../colors.js';
const TRACK = fg(AURORA.sep);
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
function getContextDisplayStyle(safePercent, thresholds) {
    // Aurora colors only: the color glides continuously along the teal→amber→rose
    // gradient; the textual suffix stays threshold-based and unchanged from before.
    const severity = getContextSeverity(safePercent, thresholds);
    const color = fg(gradientColor(safePercent));
    switch (severity) {
        case 'critical':
            return { color, suffix: ' CRITICAL' };
        case 'compact':
            return { color, suffix: ' COMPRESS?' };
        default:
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
    const { color, suffix } = getContextDisplayStyle(safePercent, thresholds);
    return `${auroraLabel(`${labels.context}:`)}${color}${safePercent}%${suffix}${RESET}`;
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
    const { color, suffix } = getContextDisplayStyle(safePercent, thresholds);
    const bar = `${color}${'█'.repeat(filled)}${TRACK}${'░'.repeat(empty)}${RESET}`;
    return `${auroraLabel(`${labels.context}:`)}[${bar}]${color}${safePercent}%${suffix}${RESET}`;
}
