/**
 * HUD - Session Health Element
 *
 * Renders session duration and health indicator.
 */
import { RESET, auroraLabel, getSessionHealthColor } from '../colors.js';
/**
 * Render session health indicator.
 *
 * Format: session:45m  (faint label + health-anchored Aurora-gradient duration)
 */
export function renderSession(session) {
    if (!session)
        return null;
    const color = getSessionHealthColor(session.health);
    return `${auroraLabel('session:')}${color}${session.durationMinutes}m${RESET}`;
}
//# sourceMappingURL=session.js.map
