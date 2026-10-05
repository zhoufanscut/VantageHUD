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
 * Extract the version that follows the model family in an ID or display name.
 * `family` is what modelFamilyKey found, so a family that ships later needs no
 * code change here either.
 * E.g., 'claude-opus-4-7-20260416'  -> '4.7'
 *       'claude-haiku-4-5-20251001' -> '4.5'
 *       'claude-fable-5'            -> '5'
 *       'anthropic/claude-opus-5.5' -> '5.5'
 *       'Opus 4.7 (1M context)'     -> '4.7'
 *       'claude-3-5-sonnet-20241022' -> '3.5'  (legacy: version before family)
 *       'claude-3-opus-20240229'    -> '3'
 */
function extractVersion(modelId, family) {
    const fam = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Version groups are 1-2 digits, and the version must end at a non-word
    // character: that rejects the trailing release date ("sonnet-20241022")
    // and a suffixed token that is not a version ("gpt-4o").
    const idMatch = modelId.match(new RegExp(`(?:^|[^a-z0-9])${fam}[-.\\s]+(\\d{1,2})(?:[-.](\\d{1,2}))?(?![\\w.])`, 'i'));
    if (idMatch)
        return idMatch[2] ? `${idMatch[1]}.${idMatch[2]}` : idMatch[1];
    // Legacy ids carry the version before the family: claude-3-5-sonnet-20241022.
    const legacyMatch = modelId.match(new RegExp(`claude[-\\s](\\d{1,2})(?:[-.](\\d{1,2}))?[-\\s]${fam}`, 'i'));
    if (legacyMatch)
        return legacyMatch[2] ? `${legacyMatch[1]}.${legacyMatch[2]}` : legacyMatch[1];
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
 * An ARN → its service (`bedrock`): an application inference profile names no model.
 * Anything else (proxy/gateway models) → the leading token, which mirrors how
 * the Claude families read: gpt-4o → gpt, deepseek-chat → deepseek, qwen2.5-72b → qwen2.5.
 */
function modelFamilyKey(source) {
    const s = String(source ?? '').toLowerCase().trim();
    if (!s)
        return null;
    if (s.includes('claude')) {
        // Current id ("claude-opus-5-5[1m]") / "Claude Opus 5.5": the token after "claude".
        const m = s.match(/claude[-\s]+([a-z][a-z0-9.]*)/);
        if (m)
            return m[1];
        // Legacy ids ("claude-3-5-sonnet-…") carry the family after the numbers.
        const legacy = s.match(/(opus|sonnet|haiku|fable)/);
        if (legacy)
            return legacy[1];
    }
    // An ARN (a Bedrock application inference profile names no model): its service.
    if (s.startsWith('arn:'))
        return s.split(':')[2] || 'arn';
    // Non-Claude (or unrecognized): the leading token.
    const token = s.split(/[\s\-_/]+/).filter(Boolean)[0] || s;
    return truncateToWidth(token, 14);
}
/**
 * Render the model:effort fragment.
 *
 * Format: opus:high (short, default) · opus 5.5:high (versioned) · claude-opus-5-5[1m]:high (full) · opus (no effort level)
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
        const version = extractVersion(String(modelId), family);
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
