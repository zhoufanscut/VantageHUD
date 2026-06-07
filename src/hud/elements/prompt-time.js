/**
 * HUD - Prompt Time Element
 *
 * Renders elapsed time since the last user prompt, doubling as a prompt-cache-age
 * gauge (teal while warm, rose once the 5-min cache TTL lapses). The timestamp is
 * derived from the transcript's most recent user-prompt entry, falling back to a
 * UserPromptSubmit hook timestamp (hudState.lastPromptTimestamp) if one is present.
 */
import { paint, auroraFaint, AURORA } from '../colors.js';
/**
 * Anthropic prompt-cache TTL. Once the idle gap since the last prompt exceeds
 * this, the next turn re-reads the full context uncached (a cache miss), so the
 * elapsed timer flips from warm (teal) to alert (rose).
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Format elapsed milliseconds as human-readable duration.
 * < 60s  → 13s
 * < 1h   → 1m23s
 * >= 1h  → 2h3m
 */
function formatElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60)
        return `${totalSeconds}s`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60)
        return `${totalMinutes}m${totalSeconds % 60}s`;
    const hours = Math.floor(totalMinutes / 60);
    return `${hours}h${totalMinutes % 60}m`;
}
/**
 * Render elapsed time since prompt submission.
 *
 * Format: ⏱13s  or  ⏱1m23s  or  ⏱2h3m
 * Falls back to HH:MM:SS timestamp if now is not provided.
 */
export function renderPromptTime(promptTime, now) {
    if (!promptTime)
        return null;
    if (now) {
        const elapsed = now.getTime() - promptTime.getTime();
        if (elapsed >= 0) {
            // Teal while the prompt cache is still warm; rose once the 5-minute
            // TTL has lapsed and the next turn will miss the cache.
            const color = elapsed >= CACHE_TTL_MS ? AURORA.gradHigh : AURORA.gradLow;
            return `${auroraFaint('⏱')}${paint(color, formatElapsed(elapsed))}`;
        }
    }
    const hours = String(promptTime.getHours()).padStart(2, '0');
    const minutes = String(promptTime.getMinutes()).padStart(2, '0');
    const seconds = String(promptTime.getSeconds()).padStart(2, '0');
    return `${auroraFaint('prompt:')}${paint(AURORA.label, `${hours}:${minutes}:${seconds}`)}`;
}
