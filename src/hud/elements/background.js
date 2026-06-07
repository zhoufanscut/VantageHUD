/**
 * HUD - Background Tasks Element
 *
 * Renders background task count display.
 */
import { DEFAULT_HUD_LABELS } from '../types.js';
import { RESET } from '../colors.js';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
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
    // Color based on capacity usage
    let color;
    if (running >= MAX_CONCURRENT) {
        color = YELLOW; // At capacity
    }
    else if (running >= MAX_CONCURRENT - 1) {
        color = CYAN; // Near capacity
    }
    else {
        color = GREEN; // Plenty of room
    }
    return `${labels.background}:${color}${running}/${MAX_CONCURRENT}${RESET}`;
}
