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
import { DEFAULT_HUD_CONFIG, isHudLocale, resolveHudLabels, } from "./types.js";
/**
 * Read HUD configuration from disk.
 * Priority: the HUD's own `config.json` (see `getHudConfigFile`) > defaults.
 *
 * This is the HUD's *own* config file — its top-level object IS the config (no
 * wrapper key). It is read directly, independent of Claude Code's settings.json
 * schema, so it can never be stripped on Claude Code's settings write-back.
 */
export function readHudConfig() {
    const configFile = getHudConfigFile();
    if (existsSync(configFile)) {
        try {
            const content = readFileSync(configFile, "utf-8");
            const config = JSON.parse(content);
            if (config && typeof config === "object") {
                return mergeWithDefaults(config);
            }
        }
        catch (error) {
            console.error("[HUD] Failed to read config.json:", error instanceof Error ? error.message : error);
        }
    }
    return DEFAULT_HUD_CONFIG;
}
/**
 * Merge partial config with defaults
 */
function mergeWithDefaults(config) {
    const locale = isHudLocale(config.locale)
        ? config.locale
        : DEFAULT_HUD_CONFIG.locale;
    return {
        locale,
        labels: resolveHudLabels(locale, config.labels),
        elements: {
            ...DEFAULT_HUD_CONFIG.elements, // Base defaults
            ...config.elements, // User overrides
        },
        thresholds: {
            ...DEFAULT_HUD_CONFIG.thresholds,
            ...config.thresholds,
        },
        contextLimitWarning: {
            ...DEFAULT_HUD_CONFIG.contextLimitWarning,
            ...config.contextLimitWarning,
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
