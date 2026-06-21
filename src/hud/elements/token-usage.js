/**
 * HUD - Token Usage Element
 *
 * Renders the cumulative session token total as a single key:value fragment.
 */
import { DEFAULT_HUD_LABELS } from '../types.js';
import { formatTokenCount } from '../../lib/formatting.js';
import { paint, paintLabel, PALETTE } from '../colors.js';
/**
 * Render the session token total.
 *
 * Format: token:12.3k  (faint label + slate value, matching repo:/branch:)
 *
 * `total` is the cumulative input+output across the session; formatTokenCount
 * keeps the same k/M abbreviation thresholds (<1k raw, <1M → k, ≥1M → M).
 * Returns null when there is nothing to show.
 */
export function renderTokenUsage(total, labels = DEFAULT_HUD_LABELS) {
    if (!total || total <= 0)
        return null;
    return `${paintLabel(`${labels.tokens}:`)}${paint(PALETTE.gradLow, formatTokenCount(total))}`;
}
