/**
 * HUD - Call Counts Element
 *
 * Renders the session's counts of tool calls, agent invocations, and skill
 * usages; by default it sits just before the repo/branch/status fragments.
 * (oh-my-claudecode#710)
 *
 * Format: 🔧42 🤖7 ⚡3  (emoji)
 * Format: T:42 A:7 S:3   (ASCII fallback / explicit override)
 *
 * With the opt-in `elements.workflowRuns` the Workflow-tool runs follow the
 * agents: 🔧42 🤖7 🔀2 ⚡3 / T:42 A:7 W:2 S:3. They get their own glyph rather
 * than joining 🤖 because one run starts many agents (token-tally.js has the
 * numbers).
 */
// Windows terminals (cmd.exe, PowerShell, Windows Terminal) may not render
// multi-byte emoji correctly, causing HUD layout corruption.
// WSL terminals may also lack emoji support.
import { isWSL } from '../../lib/platform.js';
import { DEFAULT_HUD_LABELS } from '../types.js';
import { paint, PALETTE } from '../colors.js';
function shouldUseAscii(format = 'auto') {
    if (format === 'ascii')
        return true;
    if (format === 'emoji')
        return false;
    return process.platform === 'win32' || isWSL();
}
function getIcons(format = 'auto', labels = DEFAULT_HUD_LABELS) {
    const useAscii = shouldUseAscii(format);
    return {
        tool: useAscii ? `${labels.tool}:` : '\u{1F527}',
        agent: useAscii ? `${labels.agent}:` : '\u{1F916}',
        workflow: useAscii ? `${labels.workflow}:` : '\u{1F500}',
        skill: useAscii ? `${labels.skill}:` : '⚡',
    };
}
/**
 * Render call counts badge.
 *
 * Omits a counter entirely when its count is zero to keep output terse.
 * Returns null if all counts are zero (nothing to show).
 *
 * @param toolCalls - Total tool_use blocks seen in transcript
 * @param agentInvocations - Total Task/proxy_Task/Agent calls seen in transcript
 * @param skillUsages - Total Skill/proxy_Skill calls seen in transcript
 * @param workflowRuns - Workflow runs launched (resumes excluded); the caller
 *   passes 0 unless `elements.workflowRuns` is on
 */
export function renderCallCounts(toolCalls, agentInvocations, skillUsages, format = 'auto', labels = DEFAULT_HUD_LABELS, workflowRuns = 0) {
    const parts = [];
    const icons = getIcons(format, labels);
    // Counts sit quietly in muted slate so they recede into the rest of the line.
    const count = (n) => paint(PALETTE.label, String(n));
    if (toolCalls > 0) {
        parts.push(`${icons.tool}${count(toolCalls)}`);
    }
    if (agentInvocations > 0) {
        parts.push(`${icons.agent}${count(agentInvocations)}`);
    }
    if (workflowRuns > 0) {
        parts.push(`${icons.workflow}${count(workflowRuns)}`);
    }
    if (skillUsages > 0) {
        parts.push(`${icons.skill}${count(skillUsages)}`);
    }
    return parts.length > 0 ? parts.join(' ') : null;
}
