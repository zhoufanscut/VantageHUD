/**
 * HUD - Model Element
 *
 * Renders the current model as a key:value fragment — model family as the key,
 * thinking effort as the value (e.g. `opus:high`). The key uses the faint
 * label tone (like `repo:`); the value rides the effort ramp so the effort
 * stays readable at a glance.
 */
import { paint, lerpRgb, paintLabel, PALETTE } from '../colors.js';
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
 * Map a thinking-effort level onto the three usage-gauge tokens, inverted so
 * more effort reads calmer — the ramp spans gradLow→gradMid→gradHigh end to end:
 * max → gradLow (teal), xhigh → teal-amber, high → gradMid (amber),
 * medium → amber-rose, low → gradHigh (rose).
 *
 * Effort is a discrete setting, not a measurement, so it owns an explicit
 * per-level table rather than routing through the (now three-tier) usage gauge —
 * that keeps all five levels as distinct hues, which a tier snap would collapse
 * (high and xhigh would both land in the gauge's calm band). Absent or unknown
 * levels fall back to the max (gradLow) end.
 */
const EFFORT_COLOR = {
    low: PALETTE.gradHigh, // rose — least effort, loudest
    medium: lerpRgb(PALETTE.gradMid, PALETTE.gradHigh, 0.5), // amber-rose
    high: PALETTE.gradMid, // amber
    xhigh: lerpRgb(PALETTE.gradLow, PALETTE.gradMid, 0.5), // teal-amber
    max: PALETTE.gradLow, // gauge calm end (teal) — most effort, calmest
};
function effortColor(level) {
    const key = level == null ? 'max' : String(level).toLowerCase();
    return EFFORT_COLOR[key] ?? PALETTE.gradLow;
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
 * Format: opus:high (short, default) · opus 4.8:high (versioned) · claude-opus-4-8:high (full) · opus (no effort level)
 *
 * Key uses the faint label tone (like `repo:`); the effort value is colored on
 * the effort ramp (max→gradLow … low→gradHigh). When no effort level is present
 * the colon is dropped and the family alone renders on the ramp's calm (gradLow) end.
 */
export function renderModel(modelId, format = 'short', effortLevel = null) {
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
    return `${paintLabel(`${key}:`)}${paint(effortColor(effortLevel), String(effortLevel).toLowerCase())}`;
}
