/**
 * HUD - Agents Element
 *
 * Renders the active-agent count (e.g. `agents:2`). Header-only: the HUD is a
 * single line, so the former per-agent detail lines are no longer rendered.
 */
import { auroraLabel, auroraAccent } from '../colors.js';
/**
 * Render the active-agent count fragment, or null when none are running.
 *
 * Format: agents:2
 */
export function renderAgents(agents) {
    const running = Array.isArray(agents)
        ? agents.filter((a) => a?.status === 'running')
        : [];
    if (running.length === 0) {
        return null;
    }
    return `${auroraLabel('agents:')}${auroraAccent(String(running.length))}`;
}
