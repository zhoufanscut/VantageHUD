/**
 * HUD - Prompt Time Element
 *
 * Renders a prompt-cache-age gauge: elapsed time since the last API round-trip
 * (teal while warm, rose once the 5-min cache TTL lapses). The timestamp is the
 * transcript's most recent main-thread user/assistant turn — typed prompts,
 * tool_results (incl. AskUserQuestion answers), and assistant responses all count,
 * since each re-reads and refreshes the prompt cache; teammate/subagent turns
 * (which Claude Code records in their own separate transcripts) never touch the
 * lead's cache and so are excluded.
 * Falls back to the last typed prompt, then a UserPromptSubmit hook timestamp
 * (hudState.lastPromptTimestamp), if the activity signal is unavailable.
 */
import { paint, gradientColor, paintFaint, PALETTE } from '../colors.js';
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
 * Format: ⌚13s  or  ⌚1m23s  or  ⌚2h3m
 * Falls back to HH:MM:SS timestamp if now is not provided.
 */
export function renderPromptTime(promptTime, now) {
    if (!promptTime)
        return null;
    if (now) {
        const elapsed = now.getTime() - promptTime.getTime();
        if (elapsed >= 0) {
            // Three-tier teal→amber→rose snap across the 5-min cache TTL: teal
            // when fresh, amber from ~3.5min (70%), rose from ~4.25min (85%) —
            // the same tiers as ctx/limits/session.
            const color = gradientColor((elapsed / CACHE_TTL_MS) * 100);
            // Icon left unpainted so it renders as a native-color emoji, matching
            // the raw tool/agent/skill icons in call-counts (which apply no SGR).
            return `⌚${paint(color, formatElapsed(elapsed))}`;
        }
    }
    const hours = String(promptTime.getHours()).padStart(2, '0');
    const minutes = String(promptTime.getMinutes()).padStart(2, '0');
    const seconds = String(promptTime.getSeconds()).padStart(2, '0');
    return `${paintFaint('prompt:')}${paint(PALETTE.label, `${hours}:${minutes}:${seconds}`)}`;
}
