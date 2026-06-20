/**
 * HUD - Background Tasks Element
 *
 * Renders background task count display.
 */
import { DEFAULT_HUD_LABELS } from '../types.js';
import { RESET, fg, gradientColor, auroraLabel } from '../colors.js';
const MAX_CONCURRENT = 5;
/**
 * Render background task count.
 * Returns null if no tasks are running.
 *
 * Format: bg:3/5
 */
export function renderBackground(tasks, labels = DEFAULT_HUD_LABELS) {
    const running = tasks.filter((t) => t.status === 'running').length;
    if (running === 0) {
        return null;
    }
    // Capacity pressure rides the Aurora gradient: teal when free → rose at capacity.
    const color = fg(gradientColor((running / MAX_CONCURRENT) * 100));
    return `${auroraLabel(`${labels.background}:`)}${color}${running}/${MAX_CONCURRENT}${RESET}`;
}
