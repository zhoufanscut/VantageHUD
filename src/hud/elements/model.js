/**
 * HUD - Model Element
 *
 * Renders the current model name with thinking effort folded in.
 */
import { paint, gradientColor } from '../colors.js';
import { truncateToWidth } from '../../lib/string-width.js';
/**
 * Extract version from a model ID string.
 * E.g., 'claude-opus-4-7-20260416' -> '4.7'
 *       'claude-sonnet-4-6-20260217' -> '4.6'
 *       'claude-haiku-4-5-20251001' -> '4.5'
 *       'claude-3-5-sonnet-20241022' -> '3.5'
 *       'claude-3-opus-20240229' -> '3'
 */
function extractVersion(modelId) {
    // Match hyphenated ID patterns like opus-4-6, sonnet-4-5, haiku-4-5
    const idMatch = modelId.match(/(?:opus|sonnet|haiku)-(\d+)-(\d+)/i);
    if (idMatch)
        return `${idMatch[1]}.${idMatch[2]}`;
    // Match legacy raw ID patterns like claude-3-5-sonnet-20241022 and claude-3-opus-20240229
    const legacyIdMatch = modelId.match(/claude-(\d+)(?:-(\d+))?-(?:opus|sonnet|haiku)/i);
    if (legacyIdMatch) {
        return legacyIdMatch[2] ? `${legacyIdMatch[1]}.${legacyIdMatch[2]}` : legacyIdMatch[1];
    }
    // Match display name patterns like "Sonnet 4.5", "Opus 4.7"
    const displayMatch = modelId.match(/(?:opus|sonnet|haiku)\s+(\d+(?:\.\d+)?)/i);
    if (displayMatch)
        return displayMatch[1];
    return null;
}
/**
 * Format model name for display.
 * Converts model IDs to friendly names based on the requested format.
 */
export function formatModelName(modelId, format = 'short') {
    if (!modelId)
        return null;
    if (format === 'full') {
        return truncateToWidth(modelId, 40);
    }
    const id = modelId.toLowerCase();
    let shortName = null;
    if (id.includes('opus'))
        shortName = 'Opus';
    else if (id.includes('sonnet'))
        shortName = 'Sonnet';
    else if (id.includes('haiku'))
        shortName = 'Haiku';
    if (!shortName) {
        // Return original if not recognized (CJK-aware truncation)
        return truncateToWidth(modelId, 20);
    }
    if (format === 'versioned') {
        const version = extractVersion(id);
        if (version)
            return `${shortName} ${version}`;
    }
    return shortName;
}
/**
 * Map a thinking-effort level onto the shared teal→amber→rose gauge ramp (the
 * same ramp as ctx / session / limits), inverted so more effort reads calmer:
 * max → teal, xhigh → teal-amber, high → amber, medium → amber-rose, low → rose.
 * Unknown or absent levels fall back to the max (teal) end.
 */
const EFFORT_RANK = { low: 100, medium: 75, high: 50, xhigh: 25, max: 0 };
function effortColor(level) {
    const pct = level == null ? null : EFFORT_RANK[String(level).toLowerCase()];
    return gradientColor(pct == null ? EFFORT_RANK.max : pct);
}
/**
 * Render model element.
 */
export function renderModel(modelId, format = 'versioned', effortLevel = null) {
    const name = formatModelName(modelId, format);
    if (!name)
        return null;
    // Model name + thinking effort render as one unit, colored by the effort
    // level on the shared gauge ramp (low→teal … max→rose), matching ctx/session.
    const text = effortLevel ? `${name.toLowerCase()} ${effortLevel}` : name.toLowerCase();
    return paint(effortColor(effortLevel), text);
}
