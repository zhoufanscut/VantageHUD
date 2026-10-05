/**
 * Compact duration: `45m` under an hour, `3h12m` under a day, `2d5h` beyond.
 * Shared by the rate-limit countdowns and the session timer so they read alike.
 */
export function formatDuration(totalMinutes) {
    const minutes = Math.max(0, Math.floor(Number.isFinite(totalMinutes) ? totalMinutes : 0));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0)
        return `${days}d${hours % 24}h`;
    if (hours > 0)
        return `${hours}h${minutes % 60}m`;
    return `${minutes}m`;
}
/**
 * Local wall-clock time as `HH:MM` (24-hour, zero-padded), built by hand so
 * the output never depends on the ICU data or locale Node was built with.
 * Used where a moment must stay right on a frame that stops refreshing — an
 * absolute time does, a countdown freezes (the `cache:` element).
 */
export function formatClockTime(epochMs) {
    const date = new Date(epochMs);
    const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/**
 * Compact token count: raw under 1k, `12.3k` under 1M, `1.23M` beyond. The k/M
 * switch sits at 999,950, where `toFixed(1)` would round up to `1000.0k`.
 */
export function formatTokenCount(tokens) {
    if (tokens < 1000)
        return `${tokens}`;
    if (tokens < 999950)
        return `${(tokens / 1000).toFixed(1)}k`;
    return `${(tokens / 1000000).toFixed(2)}M`;
}
