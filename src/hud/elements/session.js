/**
 * HUD - Session Health Element
 *
 * Renders session duration.
 */
import { paint, gradientColor, auroraLabel } from '../colors.js';
/**
 * Render session duration.
 *
 * Format: session:45m  (faint label + tiered Aurora duration color)
 *
 * Color snaps across the same teal→amber→rose tiers as ctx/limits, mapping
 * session age onto 0–100 (8h → 100%): teal <5.6h, amber 5.6–6.8h, rose ≥6.8h.
 */
export function renderSession(session) {
    if (!session)
        return null;
    const color = gradientColor((session.durationMinutes / (60 * 8)) * 100);
    return `${auroraLabel('session:')}${paint(color, `${session.durationMinutes}m`)}`;
}
