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
export function formatTokenCount(tokens) {
    if (tokens < 1000)
        return `${tokens}`;
    if (tokens < 1000000)
        return `${(tokens / 1000).toFixed(1)}k`;
    return `${(tokens / 1000000).toFixed(2)}M`;
}
