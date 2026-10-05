/**
 * HUD - Token Usage Element
 *
 * Renders the cumulative session token total as a single key:value fragment.
 */
import { DEFAULT_HUD_LABELS } from '../types.js';
import { formatTokenCount } from '../../lib/formatting.js';
import { paint, paintFaint, paintLabel, PALETTE } from '../colors.js';
/**
 * Render the session token total.
 *
 * Format: token:12.3k  (label tone + gradLow value, matching repo:/branch:)
 *
 * `total` is the cumulative input+output across the session — including tokens
 * spent by teammates/subagents in their own transcripts, so the figure reflects
 * the whole run, not just the lead thread. token-tally.js does the counting
 * (de-duplicated per `message.id`, scanned incrementally); subagents.js finds
 * the teammate transcripts to feed it. Cache read/creation tokens are excluded
 * by design — `ctx:` is the cache-inclusive context-window gauge.
 * formatTokenCount abbreviates: <1k raw, then k, then M from 999,950 (where
 * one decimal of k would round to 1000.0k). Returns null when there is nothing
 * to show.
 *
 * `approximate` prefixes a faint `~` (token:~12.3k), as on an approximate
 * limit reset: some call's usage never settled on disk, so the figure is a
 * lower bound. Claude Code 2.1.283+ leaves most subagent calls that way.
 */
export function renderTokenUsage(total, labels = DEFAULT_HUD_LABELS, approximate = false) {
    if (!total || total <= 0)
        return null;
    const marker = approximate ? paintFaint('~') : '';
    return `${paintLabel(`${labels.tokens}:`)}${marker}${paint(PALETTE.gradLow, formatTokenCount(total))}`;
}
