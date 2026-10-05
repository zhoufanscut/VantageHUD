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
// truecolor → 256-color → basic 16. The active theme — one of the bundled
// palettes or a user one, selected via `HUD_THEME` / config.json — is resolved
// there and surfaced here as `PALETTE`.
/**
 * Detect terminal color depth once per process.
 *   2 → 24-bit truecolor
 *   1 → 256-color
 *   0 → basic 16-color
 *  -1 → no color (fg() emits nothing; bold and resets stay)
 *
 * First match wins:
 *   1. HUD_COLOR_DEPTH = 0|1|2|none — the explicit override, for a terminal
 *      the rest guesses wrong (SSH does not forward COLORTERM, and a hook's
 *      environment can claim TERM=dumb while Claude Code renders ANSI itself).
 *   2. FORCE_COLOR = 0|false → none; 1|2|3 (or empty/true = 1) is a floor of
 *      16 / 256 / truecolor over the detection below. It beats NO_COLOR, as in
 *      Node and supports-color.
 *   3. NO_COLOR set and non-empty → none (no-color.org).
 *   4. COLORTERM = truecolor|24bit → 2.
 *   5. WT_SESSION (Windows Terminal) or TERM_PROGRAM = iTerm.app|vscode|WezTerm → 2.
 *   6. TERM = dumb → none; TERM containing "256", or a bare xterm/screen/tmux → 1.
 *   7. Anything else → 0.
 */
function detectColorDepth() {
    const env = process.env;
    const override = String(env.HUD_COLOR_DEPTH || '').trim().toLowerCase();
    if (override === 'none')
        return -1;
    if (override === '0' || override === '1' || override === '2')
        return Number(override);
    let floor = null;
    if (env.FORCE_COLOR !== undefined) {
        const force = String(env.FORCE_COLOR).trim().toLowerCase();
        if (force === '0' || force === 'false')
            return -1;
        floor = force === '2' ? 1 : force === '3' ? 2 : 0;
    }
    const detected = detectFromTerminal(env);
    return floor === null ? detected : Math.max(floor, detected);
}
function detectFromTerminal(env) {
    if (env.NO_COLOR)
        return -1;
    const colorterm = (env.COLORTERM || '').toLowerCase();
    if (colorterm.includes('truecolor') || colorterm.includes('24bit')) {
        return 2;
    }
    if (env.WT_SESSION || ['iTerm.app', 'vscode', 'WezTerm'].includes(env.TERM_PROGRAM || '')) {
        return 2;
    }
    const term = (env.TERM || '').toLowerCase();
    if (term === 'dumb')
        return -1;
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
/** xterm-256 cube channel levels (index 0..5). */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
/**
 * Convert an [r,g,b] triple to the nearest xterm-256 cube/grayscale index.
 * The cube levels are uneven (0, 95, then steps of 40), so the cut points are
 * the midpoints 48 / 115 / 155 / 195 / 235 — `floor`, not `round`: rounding
 * biased every channel half a step up and sent 255 to a 7th level that carried
 * into the next digit (#ff0000 came out as 232, near-black). The nearest of
 * the cube color and the grey ramp (232-255: 8, 18, … 238) wins.
 */
function rgbTo256(r, g, b) {
    const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
    const cr = q(r), cg = q(g), cb = q(b);
    const cube = 16 + 36 * cr + 6 * cg + cb;
    const avg = (r + g + b) / 3;
    const gi = Math.min(23, Math.max(0, Math.round((avg - 8) / 10)));
    const gv = 8 + 10 * gi;
    const dist = (x, y, z) => (r - x) ** 2 + (g - y) ** 2 + (b - z) ** 2;
    return dist(gv, gv, gv) < dist(CUBE_LEVELS[cr], CUBE_LEVELS[cg], CUBE_LEVELS[cb]) ? 232 + gi : cube;
}
/** Map an [r,g,b] triple to the closest basic-16 SGR foreground code. */
function rgbTo16(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // A channel is "on" only if it is near the max — keeps hues distinct
    // (rose → red/magenta, teal → cyan, amber → yellow) instead of all-white.
    const bit = (v) => (v >= max - 50 ? 1 : 0);
    const key = (bit(r) << 2) | (bit(g) << 1) | bit(b);
    // Near-neutral (low saturation, or every channel "on") → one of three grays
    // by lightness: black 30, bright black 90 (~128), white 37 (~192). The cut
    // to white is their midpoint, 160; the cut to black is 48 (rgbTo256's first
    // cut), not the midpoint 64, because the errors are lopsided — 90 still reads
    // on a light terminal, black on a dark one does not. A dim gray used to go
    // to black, which hid the ` | ` separator and the `░` track on every dark
    // theme, and a mid gray to white, which hid daylight's `faint` on white.
    // 97 is left out on purpose: it would only make the light text tokens
    // brighter than they are in truecolor.
    if (max - min < 40 || key === 7) {
        return max < 48 ? 30 : max < 160 ? 90 : 37;
    }
    // key: 1 blue, 2 green, 3 cyan, 4 red, 5 magenta, 6 yellow (0 and 7 never get here)
    const base = [30, 34, 32, 36, 31, 35, 33, 37][key];
    return max > 150 ? base + 60 : base;
}
/**
 * Foreground SGR opener for an [r,g,b] triple at the detected color depth.
 * Returns just the escape sequence (no text, no reset).
 */
export function fg(rgb) {
    const [r, g, b] = rgb;
    if (COLOR_DEPTH < 0)
        return '';
    if (COLOR_DEPTH === 2)
        return `\x1b[38;2;${r};${g};${b}m`;
    if (COLOR_DEPTH === 1)
        return `\x1b[38;5;${rgbTo256(r, g, b)}m`;
    return `\x1b[${rgbTo16(r, g, b)}m`;
}
/** Wrap text in a truecolor foreground color (with reset). */
export function paint(rgb, text) {
    // The reset stays even without color: it also ends the path's bold.
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
// Three usage tiers share the palette's gauge tokens. The default cut points
// match the default context thresholds (warning 70 / critical 85); ctx passes
// the configured ones as `bounds`, so its color and its CRITICAL text agree.
const TIER_STOPS = [PALETTE.gradLow, PALETTE.gradMid, PALETTE.gradHigh];
const TIER_BOUNDS = [70, 85];
/**
 * Usage tier color: snap a 0..100 percentage into one of three discrete bands —
 * calm (< 70) → gradLow, watch (70..84) → gradMid, alert (>= 85) → gradHigh.
 *
 * Categorical, not continuous, on purpose: the eye reads a fixed hue as a state
 * faster than it judges position along a smooth ramp, and three flat bands look
 * identical across truecolor / 256 / 16-color (a continuous lerp quantizes into
 * ragged, uneven steps once it leaves truecolor). Callers may pass custom
 * `bounds` (ascending cut points) when their semantics differ from 70/85.
 */
export function gradientColor(percent, bounds = TIER_BOUNDS) {
    const p = Math.min(100, Math.max(0, percent));
    let tier = 0;
    while (tier < bounds.length && p >= bounds[tier])
        tier++;
    // Clamp into TIER_STOPS: a caller passing more cut points than there are
    // tiers must never index past the table (fg(undefined) would throw).
    return TIER_STOPS[Math.min(tier, TIER_STOPS.length - 1)];
}
// ============================================================================
// Shared element helpers (operate on the active palette)
// ============================================================================
/** A faint hairline label tone (the quiet "ctx:" / "5h:" prefix). */
export function paintLabel(text) {
    return paint(PALETTE.label, text);
}
/** Even fainter (reset times, parentheticals). */
export function paintFaint(text) {
    return paint(PALETTE.faint, text);
}
/**
 * Warning tone: muted mid for caution, muted high for critical.
 * Stays in-palette instead of reaching for raw yellow/red.
 */
export function paintWarn(text, critical = false) {
    return paint(critical ? PALETTE.gradHigh : PALETTE.gradMid, text);
}
