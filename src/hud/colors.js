/**
 * HUD - ANSI Color Utilities
 *
 * Terminal color codes for statusline rendering.
 * Based on claude-hud reference implementation.
 */
import { ACTIVE_PALETTE, ACTIVE_THEME_NAME } from './themes.js';
// ANSI escape codes
export const RESET = '\x1b[0m';
// ============================================================================
// THEME ENGINE — Truecolor
// ============================================================================
//
// Palettes (the color *data*) live in `themes.js`; this file is the engine that
// turns a palette token into an escape sequence and degrades gracefully:
// truecolor → 256-color → basic 16. The active theme — slate-cool "aurora" or
// warm "ember", selected via `HUD_THEME` / config.json — is resolved there and
// surfaced here as `PALETTE`.
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
 * The themed stops are close in luminance, so RGB lerp stays smooth and calm.
 */
export function lerpRgb(c1, c2, t) {
    const k = Math.min(1, Math.max(0, t));
    return [
        Math.round(lerp(c1[0], c2[0], k)),
        Math.round(lerp(c1[1], c2[1], k)),
        Math.round(lerp(c1[2], c2[2], k)),
    ];
}
// -- Active palette ----------------------------------------------------------
// THEME SEAM: every element routes its color through these tokens (directly, or
// via the helpers below) — none reach for a raw ANSI hue. The palette is chosen
// in `themes.js` (env / config.json / default) before any element imports it,
// so swapping `theme` reskins the whole HUD. Add new palettes in `themes.js`.
export const PALETTE = ACTIVE_PALETTE;
/** The resolved theme name for this process (handy under HUD_DEBUG). */
export const THEME_NAME = ACTIVE_THEME_NAME;
// Back-compat alias for the active `PALETTE` (historical name from when
// "aurora" was the only theme). Existing imports keep working; new code should
// prefer `PALETTE`.
export const AURORA = PALETTE;
/**
 * Usage gradient: map a 0..100 percentage to a color that glides
 * low → mid → high. Two linear segments meet at the 50% midpoint, so the
 * color visibly changes with state while never snapping between bands.
 */
export function gradientColor(percent) {
    const p = Math.min(100, Math.max(0, percent));
    if (p <= 50) {
        return lerpRgb(PALETTE.gradLow, PALETTE.gradMid, p / 50);
    }
    return lerpRgb(PALETTE.gradMid, PALETTE.gradHigh, (p - 50) / 50);
}
// ============================================================================
// Shared element helpers (operate on the active palette)
// ============================================================================
/** A faint hairline label tone (the quiet "ctx:" / "5h:" prefix). */
export function auroraLabel(text) {
    return paint(PALETTE.label, text);
}
/** Even fainter (reset times, parentheticals). */
export function auroraFaint(text) {
    return paint(PALETTE.faint, text);
}
/** Primary text tone for readable values. */
export function auroraText(text) {
    return paint(PALETTE.text, text);
}
/** Neutral identity accent: repo, branch, host, key, skill. */
export function auroraAccent(text) {
    return paint(PALETTE.accent, text);
}
/**
 * Warning tone: muted mid for caution, muted high for critical.
 * Stays in-palette instead of reaching for raw yellow/red.
 */
export function auroraWarn(text, critical = false) {
    return paint(critical ? PALETTE.gradHigh : PALETTE.gradMid, text);
}
