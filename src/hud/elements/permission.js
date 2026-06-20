/**
 * HUD - Permission Status Element
 *
 * Renders heuristic-based permission pending indicator.
 */
import { auroraFaint, auroraText, auroraWarn } from '../colors.js';
/**
 * Render permission pending indicator.
 *
 * Format: APPROVE? edit:filename.ts
 */
export function renderPermission(pending) {
    if (!pending)
        return null;
    return `${auroraWarn('APPROVE?')} ${auroraFaint(pending.toolName.toLowerCase())}:${auroraText(pending.targetSummary)}`;
}
