/**
 * HUD - Model Element
 *
 * Renders the current model as a key:value fragment — model family as the key,
 * thinking effort as the value (e.g. `opus 4.8:high`). The key uses the faint
 * label tone (like `repo:`); the value rides the effort ramp so the effort
 * stays readable at a glance.
 */
import { paint, gradientColor, auroraLabel, PALETTE } from '../colors.js';
import { truncateToWidth } from '../../lib/string-width.js';
/**
 * Extract version from a model ID or display name.
 * E.g., 'claude-opus-4-7-20260416' -> '4.7'
 *       'claude-haiku-4-5-20251001' -> '4.5'
 *       'claude-fable-5'            -> '5'
 *       'claude-3-5-sonnet-20241022' -> '3.5'
 *       'claude-3-opus-20240229'    -> '3'
 *       'Opus 4.7'                  -> '4.7'
 */
function extractVersion(modelId) {
    // Match hyphenated ID patterns like opus-4-6, haiku-4-5, fable-5 (minor optional).
    // Version groups are 1-2 digits; the `(?!\d)` guards reject the trailing
    // release date (e.g. "sonnet-20241022") that would otherwise read as a version.
    const idMatch = modelId.match(/(?:opus|sonnet|haiku|fable)-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?/i);
    if (idMatch)
        return idMatch[2] ? `${idMatch[1]}.${idMatch[2]}` : idMatch[1];
    // Match legacy raw ID patterns like claude-3-5-sonnet-20241022 and claude-3-opus-20240229
    const legacyIdMatch = modelId.match(/claude-(\d{1,2})(?:-(\d{1,2}))?-(?:opus|sonnet|haiku|fable)/i);
    if (legacyIdMatch) {
        return legacyIdMatch[2] ? `${legacyIdMatch[1]}.${legacyIdMatch[2]}` : legacyIdMatch[1];
    }
    // Match display name patterns like "Sonnet 4.5", "Opus 4.7", "Fable 5"
    const displayMatch = modelId.match(/(?:opus|sonnet|haiku|fable)\s+(\d+(?:\.\d+)?)/i);
    if (displayMatch)
        return displayMatch[1];
    return null;
}
/**
 * Map a thinking-effort level onto the shared teal→amber→rose gauge ramp (the
 * same ramp as ctx / session / limits), inverted so more effort reads calmer:
 * max → accent (cyan-teal), xhigh → teal-amber, high → amber, medium → amber-rose, low → rose.
 * Absent or unknown levels fall back to the max (accent) end.
 */
const EFFORT_RANK = { low: 100, medium: 75, high: 50, xhigh: 25, max: 0 };
function effortColor(level) {
    const key = level == null ? 'max' : String(level).toLowerCase();
    const pct = EFFORT_RANK[key];
    // Max effort — and any absent/unknown level, which falls back to max — uses the
    // theme's accent tone (cyan-teal in aurora) rather than the gradient's teal end.
    if (pct == null || key === 'max')
        return PALETTE.accent;
    return gradientColor(pct);
}
/**
 * Derive the key: the model family.
 *
 * Claude models → family extracted generically, so future families
 * (opus / sonnet / haiku / fable / whatever ships next) work with no code change.
 * Anything else (proxy/gateway models) → the leading token, which mirrors how
 * the Claude families read: gpt-4o → gpt, deepseek-chat → deepseek, qwen2.5-72b → qwen2.5.
 */
function modelFamilyKey(source) {
    const s = String(source ?? '').toLowerCase().trim();
    if (!s)
        return null;
    if (s.includes('claude')) {
        // Current id ("claude-opus-4-8…") / "Claude Opus 4.8": the token after "claude".
        const m = s.match(/claude[-\s]+([a-z][a-z0-9.]*)/);
        if (m)
            return m[1];
        // Legacy ids ("claude-3-5-sonnet-…") carry the family after the numbers.
        const legacy = s.match(/(opus|sonnet|haiku|fable)/);
        if (legacy)
            return legacy[1];
    }
    // Non-Claude (or unrecognized): the leading token.
    const token = s.split(/[\s\-_/]+/).filter(Boolean)[0] || s;
    return truncateToWidth(token, 14);
}
/**
 * Render the model:effort fragment.
 *
 * Format: opus 4.8:high (versioned) · opus:high (short) · opus (no effort level)
 *
 * Key uses the faint label tone (like `repo:`); the effort value is colored on
 * the effort ramp (max→accent … low→rose). When no effort level is present the
 * colon is dropped and the family alone renders on the ramp's calm (accent) end.
 */
export function renderModel(modelId, format = 'versioned', effortLevel = null) {
    const family = modelFamilyKey(modelId);
    if (!family)
        return null;
    let key = family;
    if (format === 'versioned') {
        const version = extractVersion(String(modelId));
        if (version)
            key = `${family} ${version}`;
    }
    else if (format === 'full') {
        // 'full' is opt-in verbosity: keep the raw id as the key.
        key = truncateToWidth(String(modelId), 40).toLowerCase();
    }
    if (!effortLevel)
        return paint(effortColor(null), key);
    return `${auroraLabel(`${key}:`)}${paint(effortColor(effortLevel), String(effortLevel).toLowerCase())}`;
}
