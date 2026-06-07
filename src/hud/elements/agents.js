/**
 * HUD - Agents Element
 *
 * Renders the active-agent multi-line display: a header count plus one detail
 * line per running agent.
 */
import { dim, RESET, getModelTierColor, getDurationColor } from '../colors.js';
import { truncateToWidth } from '../../lib/string-width.js';
const CYAN = '\x1b[36m';
// ============================================================================
// Agent Type Codes
// ============================================================================
/**
 * Single-character codes for each agent type.
 * Case indicates model tier: Uppercase = Opus, lowercase = Sonnet/Haiku
 */
const AGENT_TYPE_CODES = {
    // ============================================================
    // BUILD/ANALYSIS LANE
    // ============================================================
    // Explore - 'E' for Explore (haiku)
    explore: 'e',
    // Analyst - 'T' for aTalyst (A taken by Architect)
    analyst: 'T', // opus
    // Planner - 'P' for Planner
    planner: 'P', // opus
    // Architect - 'A' for Architect
    architect: 'A', // opus
    // Debugger - 'g' for debuGger (d taken by designer)
    debugger: 'g', // sonnet
    // Executor - 'x' for eXecutor (sonnet default, opus for complex tasks)
    executor: 'x', // sonnet/opus
    // Verifier - 'V' for Verifier (but vision uses 'v'... use uppercase 'V' for governance role)
    verifier: 'V', // sonnet
    // ============================================================
    // REVIEW LANE
    // ============================================================
    // Style Reviewer - 'Y' for stYle
    'style-reviewer': 'y', // haiku
    // API Reviewer - 'I' for Interface/API
    'api-reviewer': 'i', // sonnet
    // Security Reviewer - 'K' for Security (S taken by Scientist)
    'security-reviewer': 'K', // sonnet
    // Performance Reviewer - 'O' for perfOrmance
    'performance-reviewer': 'o', // sonnet
    // Code Reviewer - 'R' for Review (uppercase, opus tier)
    'code-reviewer': 'R', // opus
    // ============================================================
    // DOMAIN SPECIALISTS
    // ============================================================
    // Dependency Expert - 'L' for Library expert
    'dependency-expert': 'l', // sonnet
    // Test Engineer - 'T' (but analyst uses 'T'... use uppercase 'T')
    'test-engineer': 't', // sonnet
    // Quality Strategist - 'Qs' for Quality Strategist (disambiguated from quality-reviewer)
    'quality-strategist': 'Qs', // sonnet
    // Designer - 'd' for Designer
    designer: 'd', // sonnet
    // Writer - 'W' for Writer
    writer: 'w', // haiku
    // QA Tester - 'Q' for QA
    'qa-tester': 'q', // sonnet
    // Scientist - 'S' for Scientist
    scientist: 's', // sonnet
    // Git Master - 'M' for Master
    'git-master': 'm', // sonnet
    // ============================================================
    // PRODUCT LANE
    // ============================================================
    // Product Manager - 'Pm' for Product Manager (disambiguated from planner)
    'product-manager': 'Pm', // sonnet
    // UX Researcher - 'u' for Ux
    'ux-researcher': 'u', // sonnet
    // Information Architect - 'Ia' for Information Architect (disambiguated from api-reviewer)
    'information-architect': 'Ia', // sonnet
    // Product Analyst - 'a' for analyst
    'product-analyst': 'a', // sonnet
    // ============================================================
    // COORDINATION
    // ============================================================
    // Critic - 'C' for Critic
    critic: 'C', // opus
    // Vision - 'V' for Vision (lowercase since sonnet)
    vision: 'v', // sonnet
    // Document Specialist - 'D' for Document
    'document-specialist': 'D', // sonnet
    // ============================================================
    // BACKWARD COMPATIBILITY (Deprecated)
    // ============================================================
    // Researcher - 'r' for Researcher (deprecated, points to document-specialist)
    researcher: 'r', // sonnet
};
/**
 * Get single-character code for an agent type.
 */
function getAgentCode(agentType, model) {
    // Extract the short name from full type (e.g., "claude-statusline:architect" -> "architect")
    const parts = agentType.split(':');
    const shortName = parts[parts.length - 1] || agentType;
    // Look up the code
    let code = AGENT_TYPE_CODES[shortName];
    if (!code) {
        // Unknown agent - use first letter
        code = shortName.charAt(0).toUpperCase();
    }
    // Determine case based on model tier
    // For single-char codes, the whole code changes case
    // For multi-char codes, only the first character indicates tier
    if (model) {
        const tier = model.toLowerCase();
        if (code.length === 1) {
            code = tier.includes('opus') ? code.toUpperCase() : code.toLowerCase();
        }
        else {
            const first = tier.includes('opus') ? code[0].toUpperCase() : code[0].toLowerCase();
            code = first + code.slice(1);
        }
    }
    return code;
}
/**
 * Sort agents by start time (freshest first, oldest last)
 */
function sortByFreshest(agents) {
    return [...agents].sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
}
/**
 * Get short agent type name.
 */
function getShortAgentName(agentType) {
    const parts = agentType.split(':');
    const name = parts[parts.length - 1] || agentType;
    // Abbreviate common names
    const abbrevs = {
        // Build/Analysis Lane
        'executor': 'exec',
        'deep-executor': 'exec', // deprecated alias
        'debugger': 'debug',
        'verifier': 'verify',
        // Review Lane
        'style-reviewer': 'style',
        'quality-reviewer': 'review', // deprecated alias
        'api-reviewer': 'api-rev',
        'security-reviewer': 'sec',
        'performance-reviewer': 'perf',
        'code-reviewer': 'review',
        // Domain Specialists
        'dependency-expert': 'dep-exp',
        'document-specialist': 'doc-spec',
        'test-engineer': 'test-eng',
        'quality-strategist': 'qs',
        'build-fixer': 'debug', // deprecated alias
        'designer': 'design',
        'qa-tester': 'qa',
        'scientist': 'sci',
        'git-master': 'git',
        // Product Lane
        'product-manager': 'pm',
        'ux-researcher': 'uxr',
        'information-architect': 'ia',
        'product-analyst': 'pa',
        // Backward compat
        'researcher': 'dep-exp',
    };
    return abbrevs[name] || name;
}
/**
 * Format duration with padding for alignment.
 */
function formatDurationPadded(durationMs) {
    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    if (seconds < 10) {
        return '    '; // No duration for very short
    }
    else if (seconds < 60) {
        return `${seconds}s`.padStart(4);
    }
    else if (minutes < 10) {
        return `${minutes}m`.padStart(4);
    }
    else {
        return `${minutes}m`.padStart(4);
    }
}
/**
 * Render agents as multi-line display for maximum clarity.
 * Returns header addition + multiple detail lines.
 *
 * Format:
 * ├─ O architect     2m   analyzing architecture patterns...
 * ├─ e explore    45s  searching for test files
 * └─ x exec       1m   implementing validation logic
 */
export function renderAgentsMultiLine(agents, maxLines = 5) {
    const running = sortByFreshest(agents.filter((a) => a.status === 'running'));
    if (running.length === 0) {
        return { headerPart: null, detailLines: [] };
    }
    // Header part shows count for awareness
    const headerPart = `agents:${CYAN}${running.length}${RESET}`;
    // Build detail lines
    const now = Date.now();
    const detailLines = [];
    const displayCount = Math.min(running.length, maxLines);
    running.slice(0, maxLines).forEach((a, index) => {
        const isLast = index === displayCount - 1 && running.length <= maxLines;
        const prefix = isLast ? '└─' : '├─';
        const code = getAgentCode(a.type, a.model);
        const color = getModelTierColor(a.model);
        const shortName = getShortAgentName(a.type).padEnd(12);
        const durationMs = now - a.startTime.getTime();
        const duration = formatDurationPadded(durationMs);
        const durationColor = getDurationColor(durationMs);
        const desc = a.description || '...';
        // Use CJK-aware truncation (45 visual columns)
        const truncatedDesc = truncateToWidth(desc, 45);
        detailLines.push(`${dim(prefix)} ${color}${code}${RESET} ${dim(shortName)}${durationColor}${duration}${RESET}  ${truncatedDesc}`);
    });
    // Add overflow indicator if needed
    if (running.length > maxLines) {
        const remaining = running.length - maxLines;
        detailLines.push(`${dim(`└─ +${remaining} more agents...`)}`);
    }
    return { headerPart, detailLines };
}
