#!/usr/bin/env node
/**
 * HUD - Theme Preview
 *
 * Renders every theme — bundled and user-defined — as a sample status line, so
 * they can be compared side by side in one screen.
 *
 *   node preview-themes.mjs              # every theme, at your terminal's depth
 *   node preview-themes.mjs nebula ember # just these
 *   node preview-themes.mjs --depth=0    # preview the 16-color fallback
 *   node preview-themes.mjs --ascii      # preview safeMode's glyph swap
 *
 * The sample lines are *representative*, not the live HUD: they hard-code
 * plausible values so every theme shows identical content and every token gets
 * painted. For the real thing, run the HUD with `HUD_THEME=<name>`.
 *
 * Colors come from `resolvePalette()` and `fg()` — the same registry and the
 * same escape-generation the HUD uses, so a preview can never drift from a
 * render. Palettes are resolved per theme here because `colors.js` freezes
 * `PALETTE` at import: one process can only ever have one *active* theme.
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { fg, RESET } from './src/hud/colors.js';
import { DEFAULT_THEME, listThemes, resolvePalette, THEME_TOKENS } from './src/hud/themes.js';

// One line each, kept here rather than in `THEMES`: a palette is exactly 10
// color tokens, and an 11th key would trip the parity check in themes.js.
const NOTES = {
    aurora: 'cool slate, soft cyan-teal accents (Nord / Tokyo-Night family)',
    ember: 'warm dark, gold and orange (Gruvbox family)',
    nebula: 'vivid dark, mauve and pink (Catppuccin Mocha family)',
    graphite: 'near-monochrome dark — only the usage ramp carries hue',
    daylight: 'for a LIGHT terminal background (GitHub-light family)',
};

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
    console.log(`Usage: node preview-themes.mjs [theme...] [--depth=0|1|2] [--ascii]

  (no theme)   preview every bundled and user-defined theme
  --depth=N    force color depth: 2 truecolor, 1 = 256, 0 = basic 16
  --ascii      swap bar glyphs for ASCII, as safeMode does when rendering

Available: ${listThemes().join(', ')}`);
    process.exit(0);
}

// `colors.js` picks its color depth from the environment at import, so a forced
// depth means re-running with that environment rather than second-guessing `fg`.
const depthFlag = args.find((a) => a.startsWith('--depth='));
if (depthFlag) {
    const depth = depthFlag.slice('--depth='.length);
    const env = { ...process.env };
    delete env.COLORTERM;
    if (depth === '2')
        env.COLORTERM = 'truecolor';
    else if (depth === '1')
        env.TERM = 'xterm-256color';
    else if (depth === '0')
        env.TERM = 'dumb';
    else {
        console.error(`unknown --depth=${depth} (expected 0, 1 or 2)`);
        process.exit(1);
    }
    // fileURLToPath, not URL.pathname: the latter keeps a leading slash on
    // Windows drive paths (/C:/…), which spawn cannot resolve.
    const rest = args.filter((a) => a !== depthFlag);
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...rest], { env, stdio: 'inherit' });
    process.exit(run.status ?? 0);
}

const ascii = args.includes('--ascii');
const FILL = ascii ? '#' : '█';
const EMPTY = ascii ? '-' : '░';

const wanted = args.filter((a) => !a.startsWith('-'));
const unknown = wanted.filter((name) => !listThemes().includes(name.toLowerCase()));
if (unknown.length) {
    console.error(`unknown theme(s): ${unknown.join(', ')}\navailable: ${listThemes().join(', ')}`);
    process.exit(1);
}
const themes = wanted.length ? wanted.map((n) => n.toLowerCase()) : listThemes();

/** Paint `text` in one palette token. */
const paint = (palette, token, text) => `${fg(palette[token])}${text}${RESET}`;

/** A gauge bar: `filled` of `width` cells in `token`, the rest in the sep track. */
function bar(palette, token, percent, width) {
    const filled = Math.round((percent / 100) * width);
    return `${fg(palette[token])}${FILL.repeat(filled)}${fg(palette.sep)}${EMPTY.repeat(width - filled)}${RESET}`;
}

/**
 * Two sample lines per theme. Between them every one of the 10 tokens is
 * painted at least once, and the usage ramp is shown at all three tiers (calm
 * 41%, watch 76%, alert 88%) — the whole point of comparing themes.
 */
function sample(palette) {
    const sep = paint(palette, 'sep', ' | ');
    const lbl = (t) => paint(palette, 'label', t);
    const gauges = [
        `\x1b[1m${paint(palette, 'text', '~/proj/api')}`,
        `${lbl('opus:')}${paint(palette, 'gradMid', 'high')}`,
        `${lbl('5h:')}[${bar(palette, 'gradLow', 41, 8)}]${paint(palette, 'gradLow', '41%')}${lbl('(3h42m)')} `
            + `${lbl('7d:')}[${bar(palette, 'gradHigh', 88, 8)}]${paint(palette, 'gradHigh', '88%')}${lbl('(2d5h)')}`,
        `${lbl('ctx:')}[${bar(palette, 'gradMid', 76, 10)}]${paint(palette, 'gradMid', '76% COMPRESS?')}`,
    ].join(sep);
    const rest = [
        `${lbl('token:')}${paint(palette, 'gradLow', '1.2M')} ${paint(palette, 'faint', '($12.40/$50)')}`,
        `${lbl('session:')}${paint(palette, 'gradLow', '3h12m')}`,
        `${lbl('repo:')}${paint(palette, 'gradLow', 'hud')}`,
        `${lbl('branch:')}${paint(palette, 'gradLow', 'main')}`,
        `${paint(palette, 'add', '✓2')} ${paint(palette, 'del', '●5')} ${paint(palette, 'track', '?1')} ${paint(palette, 'add', '⇡3')}`,
    ].join(sep);
    return [gauges, rest];
}

for (const name of themes) {
    const palette = resolvePalette(name);
    const note = NOTES[name] || 'user-defined';
    const tag = name === DEFAULT_THEME ? ' (default)' : '';
    console.log(`\n${paint(palette, 'label', `── ${name}${tag}`)} ${paint(palette, 'faint', `── ${note}`)}`);
    for (const line of sample(palette))
        console.log(`  ${line}`);
    console.log(`  ${THEME_TOKENS.map((t) => paint(palette, t, t)).join(' ')}`);
}
console.log(`\nSelect one with \`HUD_THEME=<name>\`, or \`"theme": "<name>"\` in config.json.`);
