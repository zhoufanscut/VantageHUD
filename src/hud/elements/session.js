/**
 * HUD - Session Health Element
 *
 * Renders session duration.
 */
import { paint, gradientColor, paintLabel } from '../colors.js';
import { formatDuration } from '../../lib/formatting.js';
/**
 * Render session duration.
 *
 * Format: session:45m · session:3h12m · session:2d5h — the same compact
 * duration the rate-limit countdowns use (faint label + tiered color). The
 * start is the transcript's first row, so a resumed conversation reports its
 * whole age, which is why days are reachable.
 *
 * Color snaps across the same teal→amber→rose tiers as ctx/limits, mapping
 * session age onto 0–100 (8h → 100%): teal <5.6h, amber 5.6–6.8h, rose ≥6.8h.
 */
export function renderSession(session) {
    if (!session)
        return null;
    const color = gradientColor((session.durationMinutes / (60 * 8)) * 100);
    return `${paintLabel('session:')}${paint(color, formatDuration(session.durationMinutes))}`;
}
