/**
 * HUD - Token Usage Element
 *
 * Renders last-request input/output token usage from transcript metadata.
 */
import { DEFAULT_HUD_LABELS } from '../types.js';
import { formatTokenCount } from '../../lib/formatting.js';
import { auroraLabel, auroraText, auroraFaint } from '../colors.js';
export function renderTokenUsage(usage, sessionTotalTokens, labels = DEFAULT_HUD_LABELS) {
    if (!usage)
        return null;
    const hasUsage = usage.inputTokens > 0 || usage.outputTokens > 0;
    if (!hasUsage)
        return null;
    // Label in steel, the primary i/o figure in readable slate, secondary
    // reasoning/session totals in faint slate so they recede.
    const parts = [
        `${auroraLabel(`${labels.tokens}:`)}${auroraText(`i${formatTokenCount(usage.inputTokens)}/o${formatTokenCount(usage.outputTokens)}`)}`,
    ];
    if (usage.reasoningTokens && usage.reasoningTokens > 0) {
        parts.push(auroraFaint(`r${formatTokenCount(usage.reasoningTokens)}`));
    }
    if (sessionTotalTokens && sessionTotalTokens > 0) {
        parts.push(auroraFaint(`s${formatTokenCount(sessionTotalTokens)}`));
    }
    return parts.join(' ');
}
