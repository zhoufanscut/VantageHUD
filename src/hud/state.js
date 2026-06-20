/**
 * HUD - State Management
 *
 * Manages HUD state file for background task tracking.
 */
import { existsSync, readFileSync } from "fs";
import { sessionCacheFile, ensureSessionCacheDir } from "../lib/worktree-paths.js";
import { getHudConfigFile } from "../lib/install-paths.js";
import { atomicWriteJsonSync } from "../lib/atomic-write.js";
import { DEFAULT_HUD_CONFIG, isHudLocale, resolveHudLabels, } from "./types.js";
import { cleanupStaleBackgroundTasks, markOrphanedTasksAsStale, } from "./background-cleanup.js";
// ============================================================================
// Path Helpers
// ============================================================================
/**
 * Resolve the HUD state file: `<cacheDir>/<session>/hud-state.json`.
 * Session-scoped via a per-session subfolder; a missing session id collapses to
 * the `default/` folder. The `directory` argument is unused (state no longer
 * lives under the project/worktree) but kept for call-site compatibility.
 */
function getStateFilePath(_directory, sessionId) {
    return sessionCacheFile("hud-state", sessionId);
}
// ============================================================================
// HUD State Operations
// ============================================================================
/**
 * Read HUD state from disk (checks new local and legacy local only)
 */
export function readHudState(directory, sessionId) {
    const stateFile = getStateFilePath(directory, sessionId);
    if (!existsSync(stateFile)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(stateFile, "utf-8"));
    }
    catch (error) {
        console.error("[HUD] Failed to read session state:", error instanceof Error ? error.message : error);
        return null;
    }
}
/**
 * Write HUD state to disk (local only)
 */
export function writeHudState(state, directory, sessionId) {
    try {
        ensureSessionCacheDir(sessionId);
        const stateFile = getStateFilePath(directory, sessionId);
        const nextState = sessionId ? { ...state, sessionId } : state;
        atomicWriteJsonSync(stateFile, nextState);
        return true;
    }
    catch (error) {
        console.error("[HUD] Failed to write state:", error instanceof Error ? error.message : error);
        return false;
    }
}
/**
 * Get running background tasks from state
 */
export function getRunningTasks(state) {
    // The state file is also written by external hooks (e.g. a UserPromptSubmit
    // hook adding lastPromptTimestamp), so backgroundTasks may be absent — and
    // its entries are untrusted too (a null entry must not throw).
    if (!state || !Array.isArray(state.backgroundTasks))
        return [];
    return state.backgroundTasks.filter((task) => task?.status === "running");
}
// ============================================================================
// HUD Config Operations
// ============================================================================
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
        staleTaskThresholdMinutes: config.staleTaskThresholdMinutes ??
            DEFAULT_HUD_CONFIG.staleTaskThresholdMinutes,
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
/**
 * Initialize HUD state with cleanup of stale/orphaned tasks.
 * Should be called on HUD startup.
 */
export async function initializeHUDState(directory, sessionId) {
    // Clean up stale background tasks from previous sessions
    const removedStale = await cleanupStaleBackgroundTasks(undefined, directory, sessionId);
    const markedOrphaned = await markOrphanedTasksAsStale(directory, sessionId);
    if (removedStale > 0 || markedOrphaned > 0) {
        console.error(`HUD cleanup: removed ${removedStale} stale tasks, marked ${markedOrphaned} orphaned tasks`);
    }
}
