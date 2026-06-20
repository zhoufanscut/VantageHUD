/**
 * HUD - Session Health Element
 *
 * Renders session duration and health indicator.
 */
import { paint, gradientColor, auroraLabel } from '../colors.js';
/**
 * Render session duration.
 *
 * Format: session:45m  (faint label + continuous Aurora-gradient duration)
 *
 * Color rides the same teal→amber→rose ramp as ctx/limits, mapping session age
 * onto 0–100 (8h → full rose, amber at the 4h midpoint) instead of discrete
 * health buckets.
 */
export function renderSession(session) {
    if (!session)
        return null;
    const color = gradientColor((session.durationMinutes / (60 * 8)) * 100);
    return `${auroraLabel('session:')}${paint(color, `${session.durationMinutes}m`)}`;
}
