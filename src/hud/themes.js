/**
 * HUD - Theme Registry
 *
 * A theme is a flat palette object: 11 `[r,g,b]` tokens that every statusline
 * element routes its color through (via `src/hud/colors.js`). `colors.js` is the
 * rendering *engine* (color-depth detection, `fg`/`paint`, gradient math); this
 * file is the *data* — the only place palettes are defined.
 *
 * ── Adding a theme ──────────────────────────────────────────────────────────
 * Add one entry to `THEMES` below with all 11 tokens, then select it via either
 *   • config.json  → `{ "theme": "<name>" }`
 *   • env override  → `HUD_THEME=<name>`  (handy for A/B testing a render)
 * Nothing else needs to change — colors.js and every element pick it up.
 *
 * ── Token contract (11 tokens) ──────────────────────────────────────────────
 * Each line is what the token actually paints today (verified against the
 * element files), not an aspirational role.
 *   text     path text — the only consumer
 *   label    workhorse muted tone: every `xxx:` prefix, `(reset)` tails, and the
 *            count numbers in callCounts / the promptTime fallback
 *   faint    quietest tone: `($spent/$limit)`, the stale `*`, `prompt:` fallback,
 *            `[API 429]`
 *   sep      the ` | ` separator and the empty gauge-bar track (`░`)
 *   accent   model name at max effort, and the `agents:N` count
 *   gradLow  usage-gauge low end (0%) — ALSO the static value tone for
 *            repo: / branch: / token:, so the gauge-low color and the
 *            identity-value color cannot diverge
 *   gradMid  usage gauge — mid  (50%)
 *   gradHigh usage gauge — high (100%)
 *   add      git: staged / ahead — glyph + number (positive)
 *   del      git: modified / behind — glyph + number (negative)
 *   track    git: untracked — glyph + number
 */
import { existsSync, readFileSync } from 'fs';
import { getHudConfigFile } from '../lib/install-paths.js';

/** @typedef {[number, number, number]} Rgb */
/** @typedef {Record<'text'|'label'|'faint'|'sep'|'accent'|'gradLow'|'gradMid'|'gradHigh'|'add'|'del'|'track', Rgb>} Palette */

/** @type {Record<string, Palette>} */
export const THEMES = {
    // Aurora — cool desaturated slate with soft cyan-teal-blue accents (Nord /
    // Tokyo-Night family). The original HUD palette: calm, nothing jarring.
    aurora: {
        text: [200, 211, 232], // #c8d3e8 soft slate
        label: [143, 208, 216], // #8fd0d8 cyan-teal
        faint: [110, 120, 150], // #6e7896 quiet slate
        sep: [72, 80, 106], // #48506a hairline
        accent: [143, 208, 216], // #8fd0d8 cyan-teal
        gradLow: [127, 212, 196], // #7fd4c4 teal
        gradMid: [227, 192, 138], // #e3c08a amber
        gradHigh: [224, 144, 158], // #e0909e rose
        add: [143, 208, 184], // #8fd0b8 mint-green
        del: [224, 144, 158], // #e0909e rose
        track: [143, 196, 216], // #8fc4d8 soft cyan
    },
    // Ember — warm dark in the Gruvbox family. Toasted-sand text, gold/orange
    // accents, green→gold→red usage ramp. The warm twin of Aurora.
    ember: {
        text: [235, 219, 178], // #ebdbb2 sand
        label: [168, 153, 132], // #a89984 tan
        faint: [146, 131, 116], // #928374 warm gray
        sep: [102, 92, 84], // #665c54 brown hairline
        accent: [142, 192, 124], // #8ec07c aqua
        gradLow: [152, 151, 26], // #98971a green
        gradMid: [250, 189, 47], // #fabd2f gold
        gradHigh: [251, 73, 52], // #fb4934 red
        add: [152, 151, 26], // #98971a green
        del: [251, 73, 52], // #fb4934 red
        track: [254, 128, 25], // #fe8019 orange
    },
};

/** Fallback theme when none is configured (or an unknown name is given). */
export const DEFAULT_THEME = 'aurora';

/** All registered theme names. */
export function listThemes() {
    return Object.keys(THEMES);
}

/**
 * Read `theme` from the HUD's `config.json`. Never throws.
 *
 * Intentionally a minimal, stdlib-only read (not a reuse of
 * `state.js#readHudConfig`): this runs at import to pick the palette *before*
 * the config layer loads, and `state.js` pulls in heavy modules — routing
 * through it would risk an import cycle. The duplicated parse is one small file,
 * once per process.
 */
function readConfiguredTheme() {
    try {
        const file = getHudConfigFile();
        if (!existsSync(file))
            return null;
        const config = JSON.parse(readFileSync(file, 'utf-8'));
        const name = config?.theme;
        return typeof name === 'string' ? name.toLowerCase().trim() : null;
    }
    catch {
        return null;
    }
}

/**
 * Resolve the active theme name.
 * Priority: `HUD_THEME` env > config.json `theme` > `DEFAULT_THEME`.
 * An unknown name at any tier falls through to the next.
 *
 * Resolution happens at import (not render) on purpose: elements freeze
 * per-token escape sequences into module-level constants (e.g.
 * `const LABEL = fg(PALETTE.label)`), so the palette must be chosen before
 * those modules evaluate — i.e. before `main()` reads the runtime config.
 */
function resolveThemeName() {
    const env = process.env.HUD_THEME?.toLowerCase().trim();
    if (env && THEMES[env])
        return env;
    const configured = readConfiguredTheme();
    if (configured && THEMES[configured])
        return configured;
    return DEFAULT_THEME;
}

/** The resolved theme name for this process. */
export const ACTIVE_THEME_NAME = resolveThemeName();
/** The active palette — what `colors.js` exports as `PALETTE`. */
export const ACTIVE_PALETTE = THEMES[ACTIVE_THEME_NAME] || THEMES[DEFAULT_THEME];

// Dev-only parity check: warn (never throw) when a registered palette's token
// set diverges from the canonical `aurora` palette — almost always a typo when
// adding a theme. A missing token would otherwise render that fragment blank
// (fg(undefined) throws, caught per-element). Gated behind HUD_DEBUG to honor
// the never-throw-to-the-user rule.
if (process.env.HUD_DEBUG) {
    try {
        const required = Object.keys(THEMES.aurora);
        for (const [name, palette] of Object.entries(THEMES)) {
            const missing = required.filter((k) => !(k in palette));
            const extra = Object.keys(palette).filter((k) => !required.includes(k));
            if (missing.length || extra.length) {
                console.error(`[HUD] theme "${name}" token mismatch`, { missing, extra });
            }
        }
    }
    catch {
        // Diagnostics must never break rendering.
    }
}
