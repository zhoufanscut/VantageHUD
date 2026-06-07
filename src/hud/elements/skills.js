/**
 * HUD - Skills Element
 *
 * Renders the last activated skill badge.
 */
import { cyan } from '../colors.js';
import { truncateToWidth } from '../../lib/string-width.js';
/**
 * Truncate string to max visual width with ellipsis.
 * CJK-aware: accounts for double-width characters.
 */
function truncate(str, maxWidth) {
    return truncateToWidth(str, maxWidth);
}
/**
 * Extract the display name from a skill name.
 * For namespaced skills (e.g., "claude-statusline:plan"), returns only the last segment ("plan").
 * For non-namespaced skills, returns the name unchanged.
 */
function getSkillDisplayName(skillName) {
    return skillName.split(':').pop() || skillName;
}
/**
 * Render last activated skill badge.
 * Returns null when no skill has been activated.
 *
 * Format: skill:planner
 */
export function renderLastSkill(lastSkill) {
    if (!lastSkill)
        return null;
    const argsDisplay = lastSkill.args ? `(${truncate(lastSkill.args, 15)})` : '';
    const displayName = getSkillDisplayName(lastSkill.name);
    return cyan(`skill:${displayName}${argsDisplay}`);
}
