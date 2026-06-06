/**
 * HUD - ANSI Color Utilities
 *
 * Terminal color codes for statusline rendering.
 * Based on claude-hud reference implementation.
 */
// ANSI escape codes
export const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const BRIGHT_BLUE = '\x1b[94m';
const BRIGHT_MAGENTA = '\x1b[95m';
const BRIGHT_CYAN = '\x1b[96m';
// ============================================================================
// AURORA THEME — Truecolor engine
// ============================================================================
//
// A single cohesive cool palette in the Nord / Tokyo-Night family: desaturated
// slate text with soft cyan-teal-blue accents. Usage values glide along a smooth
// teal → amber → rose gradient instead of hard traffic-light steps, so nothing is
// ever jarring. Everything degrades gracefully: truecolor → 256-color → basic 16.
/**
 * Detect terminal color depth once per process.
 *   2 → 24-bit truecolor   (COLORTERM=truecolor|24bit)
 *   1 → 256-color          (TERM contains "256")
 *   0 → basic 16-color     (fallback)
 */
function detectColorDepth() {
    const colorterm = (process.env.COLORTERM || '').toLowerCase();
    if (colorterm.includes('truecolor') || colorterm.includes('24bit')) {
        return 2;
    }
    const term = (process.env.TERM || '').toLowerCase();
    if (term.includes('256')) {
        return 1;
    }
    // Most modern emulators (iTerm2, Apple Terminal, VS Code, kitty, alacritty)
    // support at least 256 colors even when TERM is a bare "xterm".
    if (term.includes('xterm') || term.includes('screen') || term.includes('tmux')) {
        return 1;
    }
    return 0;
}
const COLOR_DEPTH = detectColorDepth();
/** Convert an [r,g,b] triple to the nearest xterm-256 cube/grayscale index. */
function rgbTo256(r, g, b) {
    // Grayscale ramp (232-255) when the channels are close to neutral.
    if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && Math.abs(r - b) < 12) {
        const gray = Math.round((r + g + b) / 3);
        if (gray < 8)
            return 16;
        if (gray > 248)
            return 231;
        return 232 + Math.round(((gray - 8) / 247) * 23);
    }
    const c = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40));
    return 16 + 36 * c(r) + 6 * c(g) + c(b);
}
/** Map an [r,g,b] triple to the closest basic-16 SGR foreground code. */
function rgbTo16(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const bright = max > 150;
    // Near-neutral (low saturation) → white/black so slate text stays calm.
    if (max - min < 40) {
        return max > 120 ? 37 : 30;
    }
    // A channel is "on" only if it is near the max — keeps hues distinct
    // (rose → red/magenta, teal → cyan, amber → yellow) instead of all-white.
    const bit = (v) => (v >= max - 50 ? 1 : 0);
    const key = (bit(r) << 2) | (bit(g) << 1) | bit(b);
    // key: 0 black,1 blue,2 green,3 cyan,4 red,5 magenta,6 yellow,7 white
    const base = [30, 34, 32, 36, 31, 35, 33, 37][key] ?? 37;
    return bright ? base + 60 : base;
}
/**
 * Foreground SGR opener for an [r,g,b] triple at the detected color depth.
 * Returns just the escape sequence (no text, no reset).
 */
export function fg(rgb) {
    const [r, g, b] = rgb;
    if (COLOR_DEPTH === 2)
        return `\x1b[38;2;${r};${g};${b}m`;
    if (COLOR_DEPTH === 1)
        return `\x1b[38;5;${rgbTo256(r, g, b)}m`;
    return `\x1b[${rgbTo16(r, g, b)}m`;
}
/**
 * Background SGR opener for an [r,g,b] triple at the detected color depth.
 * Used for gradient bars built from background-color spaces (survives safeMode).
 */
export function bg(rgb) {
    const [r, g, b] = rgb;
    if (COLOR_DEPTH === 2)
        return `\x1b[48;2;${r};${g};${b}m`;
    if (COLOR_DEPTH === 1)
        return `\x1b[48;5;${rgbTo256(r, g, b)}m`;
    return `\x1b[${rgbTo16(r, g, b) + 10}m`;
}
/** Wrap text in a truecolor foreground color (with reset). */
export function paint(rgb, text) {
    return `${fg(rgb)}${text}${RESET}`;
}
/** Linear interpolation between two scalars. */
function lerp(a, b, t) {
    return a + (b - a) * t;
}
/**
 * Interpolate between two [r,g,b] stops by t (0..1) in plain RGB space.
 * Aurora's stops are close in luminance, so RGB lerp stays smooth and calm.
 */
export function lerpRgb(c1, c2, t) {
    const k = Math.min(1, Math.max(0, t));
    return [
        Math.round(lerp(c1[0], c2[0], k)),
        Math.round(lerp(c1[1], c2[1], k)),
        Math.round(lerp(c1[2], c2[2], k)),
    ];
}
// -- Aurora palette ---------------------------------------------------------
export const AURORA = {
    // Structural text
    text: [200, 211, 232], // #c8d3e8 soft slate (path, primary)
    label: [126, 138, 168], // #7e8aa8 muted steel (ctx:/5h: labels)
    faint: [110, 120, 150], // #6e7896 reset-time / parens
    sep: [72, 80, 106], // #48506a hairline separator dot
    // Model tier tints (same cool family, gently distinct)
    opus: [180, 164, 232], // #b4a4e8 periwinkle
    sonnet: [143, 208, 216], // #8fd0d8 cyan-teal
    haiku: [168, 216, 184], // #a8d8b8 mint
    effort: [131, 144, 184], // #8390b8 steel-blue
    // Usage gradient stops: teal (low) → amber (mid) → rose (high)
    gradLow: [127, 212, 196], // #7fd4c4 desaturated teal
    gradMid: [227, 192, 138], // #e3c08a soft amber
    gradHigh: [224, 144, 158], // #e0909e muted rose
    // Git accents (kept in-family)
    add: [143, 208, 184], // #8fd0b8 mint-green (staged / ahead)
    del: [224, 144, 158], // #e0909e rose (modified / behind)
    track: [143, 196, 216], // #8fc4d8 soft cyan (untracked)
};
/**
 * Aurora usage gradient: map a 0..100 percentage to a calm color that glides
 * teal → amber → rose. Two linear segments meet at the 50% midpoint, so the
 * color visibly changes with state while never snapping between bands.
 */
export function gradientColor(percent) {
    const p = Math.min(100, Math.max(0, percent));
    if (p <= 50) {
        return lerpRgb(AURORA.gradLow, AURORA.gradMid, p / 50);
    }
    return lerpRgb(AURORA.gradMid, AURORA.gradHigh, (p - 50) / 50);
}
/** Convenience: paint text with the Aurora usage-gradient color for `percent`. */
export function gradientText(percent, text) {
    return paint(gradientColor(percent), text);
}
// ============================================================================
// Color Functions
// ============================================================================
export function green(text) {
    return `${GREEN}${text}${RESET}`;
}
export function yellow(text) {
    return `${YELLOW}${text}${RESET}`;
}
export function red(text) {
    return `${RED}${text}${RESET}`;
}
export function cyan(text) {
    return `${CYAN}${text}${RESET}`;
}
export function magenta(text) {
    return `${MAGENTA}${text}${RESET}`;
}
export function blue(text) {
    return `${BLUE}${text}${RESET}`;
}
export function dim(text) {
    return `${DIM}${text}${RESET}`;
}
export function bold(text) {
    return `${BOLD}${text}${RESET}`;
}
export function white(text) {
    return `${WHITE}${text}${RESET}`;
}
export function brightCyan(text) {
    return `${BRIGHT_CYAN}${text}${RESET}`;
}
export function brightMagenta(text) {
    return `${BRIGHT_MAGENTA}${text}${RESET}`;
}
export function brightBlue(text) {
    return `${BRIGHT_BLUE}${text}${RESET}`;
}
// ============================================================================
// Threshold-based Colors
// ============================================================================
/**
 * Get color code based on context window percentage.
 * Aurora: smooth teal→amber→rose gradient (returns a truecolor SGR opener).
 */
export function getContextColor(percent) {
    return fg(gradientColor(percent));
}
/**
 * Get color for todo progress.
 */
export function getTodoColor(completed, total) {
    if (total === 0)
        return DIM;
    const percent = (completed / total) * 100;
    if (percent >= 80)
        return GREEN;
    if (percent >= 50)
        return YELLOW;
    return CYAN;
}
// ============================================================================
// Model Tier Colors (for agent visualization)
// ============================================================================
/**
 * Get color for model tier (Aurora: gentle in-family tints).
 * - Opus: periwinkle
 * - Sonnet: cyan-teal
 * - Haiku: mint
 */
export function getModelTierColor(model) {
    if (!model)
        return fg(AURORA.sonnet); // Default/unknown
    const tier = model.toLowerCase();
    if (tier.includes('opus'))
        return fg(AURORA.opus);
    if (tier.includes('sonnet'))
        return fg(AURORA.sonnet);
    if (tier.includes('haiku'))
        return fg(AURORA.haiku);
    return fg(AURORA.sonnet); // Unknown model
}
/** Aurora RGB triple for a model tier (for elements that compose their own SGR). */
export function getModelTierRgb(model) {
    if (!model)
        return AURORA.sonnet;
    const tier = model.toLowerCase();
    if (tier.includes('opus'))
        return AURORA.opus;
    if (tier.includes('sonnet'))
        return AURORA.sonnet;
    if (tier.includes('haiku'))
        return AURORA.haiku;
    return AURORA.sonnet;
}
/**
 * Get color for agent duration (warning/alert).
 * - <2min: normal (green)
 * - 2-5min: warning (yellow)
 * - >5min: alert (red)
 */
export function getDurationColor(durationMs) {
    const minutes = durationMs / 60000;
    // Map duration onto the Aurora gradient (≈8min → full rose).
    return fg(gradientColor((minutes / 8) * 100));
}
// ============================================================================
// Progress Bars
// ============================================================================
/**
 * Create a colored progress bar.
 */
export function coloredBar(percent, width = 10) {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
    const safePercent = Number.isFinite(percent)
        ? Math.min(100, Math.max(0, percent))
        : 0;
    const filled = Math.round((safePercent / 100) * safeWidth);
    const empty = safeWidth - filled;
    const color = getContextColor(safePercent);
    return `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
}
/**
 * Create a simple numeric display with color.
 */
export function coloredValue(value, total, getColor) {
    const color = getColor(value, total);
    return `${color}${value}/${total}${RESET}`;
}
// ============================================================================
// AURORA — shared element helpers
// ============================================================================
/** A faint slate hairline label (Aurora's quiet "ctx:" / "5h:" prefix tone). */
export function auroraLabel(text) {
    return paint(AURORA.label, text);
}
/** Even fainter slate (reset times, parentheticals). */
export function auroraFaint(text) {
    return paint(AURORA.faint, text);
}
/** The Aurora separator dot (available for themes that want it; default keeps " | "). */
export const AURORA_SEPARATOR = paint(AURORA.sep, '  ·  ');
/**
 * Session-health color as an Aurora gradient anchor.
 * Maps health buckets onto the same teal→amber→rose ramp so the session
 * duration belongs to the same color story as ctx/limits.
 *   good → teal (low end), warning → amber (mid), critical → rose (high).
 */
export function getSessionHealthColor(health) {
    if (health === 'critical')
        return fg(AURORA.gradHigh);
    if (health === 'warning')
        return fg(AURORA.gradMid);
    return fg(AURORA.gradLow);
}
/**
 * Build a slim gradient bar from BACKGROUND-COLOR SPACES (survives safeMode,
 * which rewrites block glyphs but preserves SGR incl. 24-bit bg). Each filled
 * cell is tinted by its own position along the usage gradient, so the bar itself
 * glides teal→amber→rose; the empty track is a faint slate.
 *
 * @param percent 0..100 fill level
 * @param width   number of cells (each cell is one space = one column)
 * @returns ANSI string of width `width` visible columns
 */
export function gradientBar(percent, width = 8) {
    const w = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
    const p = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
    const filled = Math.round((p / 100) * w);
    let out = '';
    for (let i = 0; i < w; i += 1) {
        if (i < filled) {
            // Tint each cell by its own fractional position so the fill is a gradient.
            const cellPct = w > 1 ? (i / (w - 1)) * p : p;
            out += `${bg(gradientColor(cellPct))} ${RESET}`;
        }
        else {
            out += `${bg(AURORA.sep)} ${RESET}`;
        }
    }
    return out;
}
//# sourceMappingURL=colors.js.map
