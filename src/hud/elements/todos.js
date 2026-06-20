/**
 * HUD - Todos Element
 *
 * Renders todo progress display.
 */
import { RESET, fg, lerpRgb, AURORA, auroraLabel, auroraFaint } from "../colors.js";
import { truncateToWidth } from "../../lib/string-width.js";
/**
 * Render current in-progress todo (for full mode).
 *
 * Format: todos:2/5 (working: Implementing feature)
 */
export function renderTodosWithCurrent(todos) {
    if (todos.length === 0) {
        return null;
    }
    const completed = todos.filter((t) => t.status === "completed").length;
    const total = todos.length;
    const inProgress = todos.find((t) => t.status === "in_progress");
    // Progress gauge along the calm half of the Aurora ramp: amber while work
    // remains → teal as it completes (never rose — todos carry no danger state).
    const percent = (completed / total) * 100;
    const color = fg(lerpRgb(AURORA.gradMid, AURORA.gradLow, percent / 100));
    let result = `${auroraLabel('todos:')}${color}${completed}/${total}${RESET}`;
    if (inProgress) {
        const activeText = inProgress.activeForm || inProgress.content || "...";
        // Use CJK-aware truncation (30 visual columns)
        const truncated = truncateToWidth(activeText, 30);
        result += ` ${auroraFaint(`(working: ${truncated})`)}`;
    }
    return result;
}
