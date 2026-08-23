/**
 * HUD - Theme Registry
 *
 * A theme is a flat palette: 10 named colors that every statusline element
 * routes through (via `src/hud/colors.js`). `colors.js` is the rendering
 * *engine* (color-depth detection, `fg`/`paint`, gradient math); this file is
 * the *data* — the only place palettes are defined and resolved.
 *
 * Colors are authored as `#rrggbb` hex strings — here and in `config.json`
 * alike, so a bundled palette and a user's palette are literally the same
 * format. Hex is converted to the `[r,g,b]` triples `colors.js` consumes exactly
 * once, at the end of `resolvePalette`.
 *
 * ── Selecting a theme ───────────────────────────────────────────────────────
 *   config.json  → `{ "theme": "<name>" }`
 *   env override → `HUD_THEME=<name>`   (handy for A/B testing a render)
 *
 * ── User themes (config.json) ───────────────────────────────────────────────
 *   {
 *     "theme": "mine",
 *     "themes": {
 *       "mine": { "base": "aurora", "label": "#ff9e64", "gradHigh": "#e06c75" }
 *     }
 *   }
 * Any subset of the 10 tokens may be given; the rest come from `base` (default
 * `aurora`). `base` is a reserved key, never an 11th token. A user theme sharing
 * a bundled name shadows it — and its own `base` then resolves to the *bundled*
 * palette, which is how you retint `aurora` without renaming it. Values must be
 * `#` plus exactly 6 hex digits; anything else keeps the base's color and warns
 * under `HUD_DEBUG`.
 *
 * ── Adding a bundled theme ──────────────────────────────────────────────────
 * Add one entry to `THEMES` below with all 10 tokens as `#rrggbb` strings.
 * Nothing else needs to change — colors.js and every element pick it up.
 *
 * ── Token contract (10 tokens) ──────────────────────────────────────────────
 * Each line is what the token actually paints today (verified against the
 * element files), not an aspirational role.
 *   text     path text — the only consumer
 *   label    workhorse muted tone: every `xxx:` prefix, `(reset)` tails, and the
 *            count numbers in callCounts
 *   faint    quietest tone: `($spent/$limit)`, the stale `*`, `[API 429]`
 *   sep      the ` | ` separator and the empty gauge-bar track (`░`)
 *   gradLow  usage tier "calm" (< 70%) — ALSO the static value tone for
 *            repo: / branch: / token: (so the calm-tier and identity-value
 *            colors cannot diverge) AND the effort ramp's calm (max) end
 *   gradMid  usage tier "watch" (70–84%) — also `[API auth]` / `[API err]`
 *   gradHigh usage tier "alert" (≥ 85%) — also conflict counts, effort `low`
 *   add      git: staged / ahead — glyph + number (positive)
 *   del      git: modified / behind — glyph + number (negative)
 *   track    git: untracked — glyph + number
 */
import { existsSync, readFileSync } from 'fs';
import { getHudConfigFile } from '../lib/install-paths.js';

/** @typedef {[number, number, number]} Rgb */
/** @typedef {'text'|'label'|'faint'|'sep'|'gradLow'|'gradMid'|'gradHigh'|'add'|'del'|'track'} Token */
/** @typedef {Record<Token, string>} HexPalette */
/** @typedef {Record<Token, Rgb>} Palette */

/** @type {Record<string, HexPalette>} */
export const THEMES = {
    // Aurora — cool desaturated slate with soft cyan-teal-blue accents (Nord /
    // Tokyo-Night family). The original HUD palette: calm, nothing jarring.
    aurora: {
        text: '#c8d3e8', // soft slate
        label: '#8fd0d8', // cyan-teal
        faint: '#6e7896', // quiet slate
        sep: '#48506a', // hairline
        gradLow: '#7fd4c4', // teal
        gradMid: '#e3c08a', // amber
        gradHigh: '#e0909e', // rose
        add: '#8fd0b8', // mint-green
        del: '#e0909e', // rose
        track: '#8fc4d8', // soft cyan
    },
    // Ember — warm dark in the Gruvbox family. Toasted-sand text, gold/orange
    // accents, green→gold→red usage ramp. The warm twin of Aurora.
    ember: {
        text: '#ebdbb2', // sand
        label: '#a89984', // tan
        faint: '#928374', // warm gray
        sep: '#665c54', // brown hairline
        gradLow: '#98971a', // green
        gradMid: '#fabd2f', // gold
        gradHigh: '#fb4934', // red
        add: '#98971a', // green
        del: '#fb4934', // red
        track: '#fe8019', // orange
    },
};

/** Fallback theme when none is configured (or an unknown name is given). */
export const DEFAULT_THEME = 'aurora';

/**
 * The canonical token names, in contract order. Derived from the default theme
 * so the list can never drift from the palettes themselves.
 * @type {Token[]}
 */
export const THEME_TOKENS = /** @type {Token[]} */ (Object.keys(THEMES[DEFAULT_THEME]));

/**
 * Reserved key inside a user theme object: names the palette to inherit unset
 * tokens from. Excluded from the token set, so it can never become an 11th
 * token later.
 */
const BASE_KEY = 'base';

/**
 * Lowercased key → canonical name, for `base` and the 10 tokens. Theme *names*
 * are already matched case-insensitively; without this the keys inside a theme
 * would not be, and a stray `"Base"` was the worst kind of failure — it fell
 * through to the unknown-token branch, so the theme silently inherited the
 * default palette while the only diagnostic pointed at a "token" that isn't one.
 * @type {Record<string, string>}
 */
const CANONICAL_KEY = Object.create(null);
for (const key of [BASE_KEY, ...THEME_TOKENS])
    CANONICAL_KEY[key.toLowerCase()] = key;

/**
 * The theme's `base` value, found case-insensitively like every other key —
 * reading `user[BASE_KEY]` directly would accept `"base"` but let `"Base"` fall
 * through to the override loop, which is the exact silent-wrong-palette bug the
 * canonical-key map exists to prevent.
 * @param {Record<string, unknown>} user
 */
function readBase(user) {
    for (const key of Object.keys(user)) {
        if (CANONICAL_KEY[String(key).trim().toLowerCase()] === BASE_KEY)
            return user[key];
    }
    return undefined;
}

/**
 * Own-property test. Registry lookups must not walk the prototype chain: with
 * plain `in`/`obj[k]`, a theme (or a `base`) named `constructor` or `toString`
 * would read as an existing palette and suppress the unknown-name warning.
 */
function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

/** `#` plus exactly 6 hex digits — the only accepted color format. */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Depth cap on `base` chains; also the backstop if cycle detection ever misses. */
const MAX_BASE_DEPTH = 16;

/** Log a theme diagnostic. Gated behind HUD_DEBUG, and never throws. */
function debugWarn(message, detail) {
    if (!process.env.HUD_DEBUG)
        return;
    try {
        if (detail === undefined)
            console.error(`[HUD] theme: ${message}`);
        else
            console.error(`[HUD] theme: ${message}`, detail);
    }
    catch {
        // Diagnostics must never break rendering.
    }
}

/**
 * Parse `#rrggbb` into an [r,g,b] triple. Returns null for anything else —
 * short `#rgb`, named colors, numbers, arrays — so a typo degrades to the base
 * color instead of throwing inside `fg()`.
 * @param {unknown} hex
 * @returns {Rgb | null}
 */
function hexToRgb(hex) {
    if (typeof hex !== 'string')
        return null;
    const value = hex.trim();
    if (!HEX_RE.test(value))
        return null;
    return [
        parseInt(value.slice(1, 3), 16),
        parseInt(value.slice(3, 5), 16),
        parseInt(value.slice(5, 7), 16),
    ];
}

/** Normalize a theme name for lookup: case- and whitespace-insensitive. */
function normalizeName(name) {
    return typeof name === 'string' ? name.toLowerCase().trim() : null;
}

/**
 * Read `theme` and `themes` from the HUD's `config.json`. Never throws.
 *
 * Intentionally a minimal, stdlib-only read (not a reuse of
 * `state.js#readHudConfig`): this runs at import to pick the palette *before*
 * the config layer loads, and `state.js` pulls in heavy modules — routing
 * through it would risk an import cycle. The duplicated parse is one small file,
 * once per process, and both fields come out of that single parse.
 *
 * @returns {{ name: string | null, themes: Record<string, Record<string, unknown>> }}
 */
function readThemeConfig() {
    // Null prototype, not `{}`: `JSON.parse` makes `__proto__` a real own key, so
    // `themes[name] = value` on a plain object would invoke the inherited setter
    // and re-point the registry's prototype instead of adding an entry — silently
    // changing lookups for every *other* name.
    /** @type {Record<string, Record<string, unknown>>} */
    const themes = Object.create(null);
    try {
        const file = getHudConfigFile();
        if (!existsSync(file))
            return { name: null, themes };
        const config = JSON.parse(readFileSync(file, 'utf-8'));
        const raw = config?.themes;
        if (raw !== undefined) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                debugWarn('"themes" is not an object — ignored');
            }
            else {
                for (const [key, value] of Object.entries(raw)) {
                    const name = normalizeName(key);
                    if (!name)
                        continue;
                    if (!value || typeof value !== 'object' || Array.isArray(value)) {
                        debugWarn(`"${key}" is not an object — ignored`);
                        continue;
                    }
                    if (has(themes, name))
                        debugWarn(`"${key}" collides with an earlier theme named "${name}" — the later one wins`);
                    themes[name] = /** @type {Record<string, unknown>} */ (value);
                }
            }
        }
        return { name: normalizeName(config?.theme), themes };
    }
    catch {
        return { name: null, themes };
    }
}

const { name: CONFIGURED_THEME_NAME, themes: USER_THEMES } = readThemeConfig();

/** Every known theme name: bundled plus user-defined. */
export function listThemes() {
    return Array.from(new Set([...Object.keys(THEMES), ...Object.keys(USER_THEMES)]));
}

/** True when `name` resolves to some palette (bundled or user-defined). */
function themeExists(name) {
    return Boolean(name) && (has(THEMES, name) || has(USER_THEMES, name));
}

/**
 * Resolve `name` to a complete hex palette, applying a user theme's overrides
 * over its `base`.
 *
 * `seen` carries the names already being resolved further up the chain. A name
 * in `seen` stops the recursion and falls back to the bundled palette of that
 * name — which handles two cases with one rule:
 *   • a user theme named after a bundled one whose `base` defaults to itself →
 *     that bundled palette, i.e. a retint in place;
 *   • a genuine cycle (a → b → a) → rooted at a real palette instead of looping.
 *
 * The default `base` is therefore the theme's *own* name when it shadows a
 * bundled palette, and `DEFAULT_THEME` otherwise. Defaulting unconditionally to
 * `DEFAULT_THEME` silently broke retinting for every bundled theme but aurora:
 * `themes.ember = { label: … }` rendered aurora with one ember-ish token, and
 * nothing warned, because every name involved was valid.
 *
 * @param {string} name
 * @param {Set<string>} seen
 * @param {number} depth
 * @returns {HexPalette}
 */
function resolveHexPalette(name, seen, depth) {
    const user = has(USER_THEMES, name) ? USER_THEMES[name] : null;
    if (!user || seen.has(name) || depth > MAX_BASE_DEPTH) {
        const shadowed = has(THEMES, name);
        if (user && seen.has(name) && !shadowed)
            debugWarn(`"${name}" has a circular base — falling back to "${DEFAULT_THEME}"`);
        if (depth > MAX_BASE_DEPTH)
            debugWarn(`"${name}" exceeds the base-chain depth limit (${MAX_BASE_DEPTH})`);
        return { ...(shadowed ? THEMES[name] : THEMES[DEFAULT_THEME]) };
    }
    seen.add(name);

    // A theme that shadows a bundled name inherits from *that* palette unless it
    // says otherwise; anything else inherits from the default theme.
    const ownDefault = has(THEMES, name) ? name : DEFAULT_THEME;
    const rawBase = readBase(user);
    let baseName = ownDefault;
    if (rawBase !== undefined) {
        const normalized = normalizeName(rawBase);
        if (normalized && themeExists(normalized))
            baseName = normalized;
        else
            debugWarn(`"${name}" has an unknown base ${JSON.stringify(rawBase)} — using "${ownDefault}"`);
    }

    const palette = resolveHexPalette(baseName, seen, depth + 1);
    for (const [rawKey, value] of Object.entries(user)) {
        // Keys are matched case-insensitively, like theme names.
        const key = CANONICAL_KEY[String(rawKey).trim().toLowerCase()];
        if (key === BASE_KEY)
            continue;
        if (!key) {
            debugWarn(`"${name}" has an unknown token "${rawKey}" — ignored`);
            continue;
        }
        if (hexToRgb(value) === null) {
            debugWarn(`"${name}.${rawKey}" is not a #rrggbb color (${JSON.stringify(value)}) — keeping "${baseName}"'s`);
            continue;
        }
        palette[key] = /** @type {string} */ (value).trim();
    }
    return palette;
}

/**
 * Resolve `name` to the `[r,g,b]` palette `colors.js` consumes. Hex is parsed
 * exactly here, once. A malformed *bundled* color (a dev typo) falls back to the
 * default theme's token rather than reaching `fg()` as undefined, which would
 * throw and blank that fragment.
 * @param {string} name
 * @returns {Palette}
 */
function resolvePalette(name) {
    const hex = resolveHexPalette(name, new Set(), 0);
    const fallback = THEMES[DEFAULT_THEME];
    /** @type {Palette} */
    const palette = /** @type {Palette} */ ({});
    for (const token of THEME_TOKENS) {
        const rgb = hexToRgb(hex[token]) ?? hexToRgb(fallback[token]);
        if (rgb)
            palette[token] = rgb;
        else
            debugWarn(`token "${token}" is unresolvable in "${name}" and in "${DEFAULT_THEME}"`);
    }
    return palette;
}

/**
 * Resolve the active theme name.
 * Priority: `HUD_THEME` env > config.json `theme` > `DEFAULT_THEME`.
 * An unknown name at any tier falls through to the next. Both tiers search the
 * *merged* registry, so `HUD_THEME=mine` selects a user theme too.
 *
 * Resolution happens at import (not render) on purpose: elements freeze
 * per-token escape sequences into module-level constants (e.g.
 * `const LABEL = fg(PALETTE.label)`), so the palette must be chosen before
 * those modules evaluate — i.e. before `main()` reads the runtime config.
 */
function resolveThemeName() {
    const env = normalizeName(process.env.HUD_THEME);
    if (env && themeExists(env))
        return env;
    if (env)
        debugWarn(`unknown HUD_THEME "${env}" — falling through to config.json`);
    if (CONFIGURED_THEME_NAME && themeExists(CONFIGURED_THEME_NAME))
        return CONFIGURED_THEME_NAME;
    if (CONFIGURED_THEME_NAME)
        debugWarn(`unknown theme "${CONFIGURED_THEME_NAME}" — using "${DEFAULT_THEME}"`);
    return DEFAULT_THEME;
}

/** The resolved theme name for this process. */
export const ACTIVE_THEME_NAME = resolveThemeName();
/** The active palette — what `colors.js` exports as `PALETTE`. */
export const ACTIVE_PALETTE = resolvePalette(ACTIVE_THEME_NAME);

// Dev-only parity check: warn (never throw) when a *bundled* palette's token set
// diverges from the canonical default, or carries a non-`#rrggbb` value — almost
// always a typo when adding a theme. User themes are validated as they resolve
// (above), so only the ones actually selected cost anything. Gated behind
// HUD_DEBUG to honor the never-throw-to-the-user rule.
if (process.env.HUD_DEBUG) {
    try {
        for (const [name, palette] of Object.entries(THEMES)) {
            const missing = THEME_TOKENS.filter((k) => !(k in palette));
            const extra = Object.keys(palette).filter((k) => !THEME_TOKENS.includes(/** @type {Token} */ (k)));
            const malformed = Object.entries(palette)
                .filter(([, v]) => hexToRgb(v) === null)
                .map(([k]) => k);
            if (missing.length || extra.length || malformed.length)
                debugWarn(`bundled "${name}" token mismatch`, { missing, extra, malformed });
        }
    }
    catch {
        // Diagnostics must never break rendering.
    }
}
