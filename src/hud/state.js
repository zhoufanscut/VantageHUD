/**
 * HUD - State Management
 *
 * Manages HUD state file for background task tracking.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getClaudeConfigDir } from "../lib/config-dir.js";
import { sessionCacheFile, ensureSessionCacheDir } from "../lib/worktree-paths.js";
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
/**
 * Get Claude Code settings.json path
 */
function getSettingsFilePath() {
    return join(getClaudeConfigDir(), "settings.json");
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
 * Priority: settings.json `statusline` block > defaults.
 */
export function readHudConfig() {
    const settingsFile = getSettingsFilePath();
    if (existsSync(settingsFile)) {
        try {
            const content = readFileSync(settingsFile, "utf-8");
            const settings = JSON.parse(content);
            if (settings.statusline) {
                return mergeWithDefaults(settings.statusline);
            }
        }
        catch (error) {
            console.error("[HUD] Failed to read settings.json:", error instanceof Error ? error.message : error);
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
