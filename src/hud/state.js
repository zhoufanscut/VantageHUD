/**
 * HUD - Config
 *
 * Reads the HUD's own `config.json` and merges it over the defaults in
 * `types.js`. (This module once also kept a per-session `hud-state.json`
 * holding the persisted session start; token-tally.js now derives the session
 * start exactly from the transcript's first row, so nothing is written here.)
 */
import { existsSync, readFileSync } from "fs";
import { getHudConfigFile } from "../lib/install-paths.js";
import { parseJsonText } from "../lib/json-text.js";
import { DEFAULT_HUD_CONFIG, isHudLocale, resolveHudLabels, } from "./types.js";
/**
 * Read HUD configuration from disk.
 * Priority: the HUD's own `config.json` (see `getHudConfigFile`) > defaults.
 *
 * This is the HUD's *own* config file — its top-level object IS the config (no
 * wrapper key). It is read directly, independent of Claude Code's settings.json
 * schema, so it can never be stripped on Claude Code's settings write-back.
 *
 * A file that exists but does not parse (a trailing comma is the usual cause)
 * still yields the defaults, now flagged with `configError` so render.js can
 * show `[cfg err]`: stderr is discarded on every good render, so the message
 * logged here alone never reached the user.
 */
export function readHudConfig() {
    const configFile = getHudConfigFile();
    if (existsSync(configFile)) {
        try {
            const content = readFileSync(configFile, "utf-8");
            const config = parseJsonText(content);
            if (config && typeof config === "object" && !Array.isArray(config)) {
                return mergeWithDefaults(config);
            }
            throw new Error("the top level is not a JSON object");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[HUD] Failed to read config.json:", message);
            return { ...DEFAULT_HUD_CONFIG, configError: message };
        }
    }
    return DEFAULT_HUD_CONFIG;
}
// Keys mergeWithDefaults reads besides the ones DEFAULT_HUD_CONFIG spells out.
const OPTIONAL_TOP_LEVEL_KEYS = ["elementOrder", "maxWidth", "layout"];
// Options that used to exist: still accepted (and ignored), named as removed.
// contextLimitWarning ({threshold, autoCompact}) only wrote a
// compact-requested.json that nothing read.
const REMOVED_KEYS = ["contextLimitWarning"];
const warnedKeys = new Set();
/**
 * Under HUD_DEBUG, name each key of `section` that the HUD never reads — a
 * typo (`gitstatus`) or a removed option otherwise does nothing, silently.
 */
function warnUnknownKeys(section, known, where) {
    if (!process.env.HUD_DEBUG || !section || typeof section !== "object")
        return;
    const byLower = new Map(known.map((key) => [key.toLowerCase(), key]));
    for (const key of Object.keys(section)) {
        if (known.includes(key) || warnedKeys.has(`${where}${key}`))
            continue;
        warnedKeys.add(`${where}${key}`);
        if (REMOVED_KEYS.includes(`${where}${key}`)) {
            console.error(`[HUD] config.json: "${where}${key}" was removed and is ignored; safe to delete`);
            continue;
        }
        const near = byLower.get(key.toLowerCase());
        console.error(`[HUD] config.json: unknown key "${where}${key}" ignored${near ? ` (did you mean "${near}"?)` : ""}`);
    }
}
/** A positive whole number, or `fallback`. */
function positiveInteger(value, fallback) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 1 ? n : fallback;
}
/**
 * Merge partial config with defaults
 */
function mergeWithDefaults(config) {
    warnUnknownKeys(config, [...Object.keys(DEFAULT_HUD_CONFIG), ...OPTIONAL_TOP_LEVEL_KEYS], "");
    warnUnknownKeys(config.elements, Object.keys(DEFAULT_HUD_CONFIG.elements), "elements.");
    warnUnknownKeys(config.thresholds, Object.keys(DEFAULT_HUD_CONFIG.thresholds), "thresholds.");
    warnUnknownKeys(config.labels, Object.keys(DEFAULT_HUD_CONFIG.labels), "labels.");
    const locale = isHudLocale(config.locale)
        ? config.locale
        : DEFAULT_HUD_CONFIG.locale;
    const elements = {
        ...DEFAULT_HUD_CONFIG.elements, // Base defaults
        ...config.elements, // User overrides
    };
    // "abc" here used to blank the line down to "... (+NaN lines)".
    elements.maxOutputLines = positiveInteger(elements.maxOutputLines, DEFAULT_HUD_CONFIG.elements.maxOutputLines);
    return {
        locale,
        labels: resolveHudLabels(locale, config.labels),
        elements,
        thresholds: {
            ...DEFAULT_HUD_CONFIG.thresholds,
            ...config.thresholds,
        },
        usageApiPollIntervalMs: config.usageApiPollIntervalMs ??
            DEFAULT_HUD_CONFIG.usageApiPollIntervalMs,
        ...(config.elementOrder !== undefined
            ? { elementOrder: config.elementOrder }
            : {}),
        wrapMode: config.wrapMode ?? DEFAULT_HUD_CONFIG.wrapMode,
        ...(config.maxWidth != null ? { maxWidth: config.maxWidth } : {}),
        ...(config.layout ? { layout: config.layout } : {}),
    };
}
