/**
 * HUD - State Management
 *
 * Manages HUD state file for background task tracking.
 */
import { existsSync, readFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { getClaudeConfigDir } from "../lib/config-dir.js";
import { validateWorkingDirectory, getStateRoot, ensureSessionStateDir, resolveSessionStatePath, } from "../lib/worktree-paths.js";
import { atomicWriteJsonSync } from "../lib/atomic-write.js";
import { DEFAULT_HUD_CONFIG, PRESET_CONFIGS, isHudLocale, resolveHudLabels, sanitizeHudLabels, } from "./types.js";
import { cleanupStaleBackgroundTasks, markOrphanedTasksAsStale, } from "./background-cleanup.js";
// ============================================================================
// Path Helpers
// ============================================================================
/**
 * Get the HUD state file path in the project's .claude-statusline/state directory
 */
function getLocalStateFilePath(directory) {
    const baseDir = validateWorkingDirectory(directory);
    const stateDir = join(getStateRoot(baseDir), "state");
    return join(stateDir, "hud-state.json");
}
function getLegacyRootStateFilePath(directory) {
    const baseDir = validateWorkingDirectory(directory);
    return join(getStateRoot(baseDir), "hud-state.json");
}
function getStateFilePath(directory, sessionId) {
    const baseDir = validateWorkingDirectory(directory);
    if (sessionId) {
        return resolveSessionStatePath("hud", sessionId, baseDir);
    }
    return getLocalStateFilePath(baseDir);
}
/**
 * Get Claude Code settings.json path
 */
function getSettingsFilePath() {
    return join(getClaudeConfigDir(), "settings.json");
}
/**
 * Get the HUD config file path (legacy)
 */
function getConfigFilePath() {
    return join(getClaudeConfigDir(), ".claude-statusline", "hud-config.json");
}
function readJsonFile(filePath) {
    if (!existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    }
    catch {
        return null;
    }
}
function getLegacyHudConfig() {
    return readJsonFile(getConfigFilePath());
}
function mergeElements(primary, secondary) {
    return {
        ...(primary ?? {}),
        ...(secondary ?? {}),
    };
}
function mergeThresholds(primary, secondary) {
    return {
        ...(primary ?? {}),
        ...(secondary ?? {}),
    };
}
function mergeContextLimitWarning(primary, secondary) {
    return {
        ...(primary ?? {}),
        ...(secondary ?? {}),
    };
}
/**
 * Ensure the .claude-statusline/state directory exists
 */
function ensureStateDir(directory) {
    const baseDir = validateWorkingDirectory(directory);
    const stateDir = join(getStateRoot(baseDir), "state");
    if (!existsSync(stateDir)) {
        mkdirSync(stateDir, { recursive: true });
    }
}
function ensureHudStateDir(directory, sessionId) {
    if (sessionId) {
        ensureSessionStateDir(sessionId, validateWorkingDirectory(directory));
        return;
    }
    ensureStateDir(directory);
}
// ============================================================================
// HUD State Operations
// ============================================================================
/**
 * Read HUD state from disk (checks new local and legacy local only)
 */
export function readHudState(directory, sessionId) {
    // Session-scoped HUD state should never fall back to root/legacy files.
    // This prevents a stale root state from being revived after a pane/session
    // recreation when the current session has already been identified.
    if (sessionId) {
        const sessionStateFile = getStateFilePath(directory, sessionId);
        if (!existsSync(sessionStateFile)) {
            return null;
        }
        try {
            const content = readFileSync(sessionStateFile, "utf-8");
            return JSON.parse(content);
        }
        catch (error) {
            console.error("[HUD] Failed to read session state:", error instanceof Error ? error.message : error);
            return null;
        }
    }
    // Check new local state first (.claude-statusline/state/hud-state.json)
    const localStateFile = getLocalStateFilePath(directory);
    if (existsSync(localStateFile)) {
        try {
            const content = readFileSync(localStateFile, "utf-8");
            return JSON.parse(content);
        }
        catch (error) {
            console.error("[HUD] Failed to read local state:", error instanceof Error ? error.message : error);
            // Fall through to legacy check
        }
    }
    // Check legacy local state (.claude-statusline/hud-state.json)
    const legacyStateFile = getLegacyRootStateFilePath(directory);
    if (existsSync(legacyStateFile)) {
        try {
            const content = readFileSync(legacyStateFile, "utf-8");
            return JSON.parse(content);
        }
        catch (error) {
            console.error("[HUD] Failed to read legacy state:", error instanceof Error ? error.message : error);
            return null;
        }
    }
    return null;
}
/**
 * Write HUD state to disk (local only)
 */
export function writeHudState(state, directory, sessionId) {
    try {
        // Write to the session-scoped file when the current session is known,
        // otherwise keep the legacy local path for backwards compatibility.
        ensureHudStateDir(directory, sessionId);
        const stateFile = getStateFilePath(directory, sessionId);
        const nextState = sessionId ? { ...state, sessionId } : state;
        atomicWriteJsonSync(stateFile, nextState);
        if (sessionId) {
            const legacyCandidates = [
                getLegacyRootStateFilePath(directory),
            ];
            for (const legacyFile of legacyCandidates) {
                if (!existsSync(legacyFile)) {
                    continue;
                }
                try {
                    const content = readFileSync(legacyFile, "utf-8");
                    const legacyState = JSON.parse(content);
                    if (!legacyState.sessionId || legacyState.sessionId === sessionId) {
                        unlinkSync(legacyFile);
                    }
                }
                catch {
                    // Best-effort ghost cleanup only.
                }
            }
        }
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
    if (!state)
        return [];
    return state.backgroundTasks.filter((task) => task.status === "running");
}
// ============================================================================
// HUD Config Operations
// ============================================================================
/**
 * Read HUD configuration from disk.
 * Priority: settings.json > hud-config.json (legacy) > defaults
 */
export function readHudConfig() {
    const settingsFile = getSettingsFilePath();
    const legacyConfig = getLegacyHudConfig();
    if (existsSync(settingsFile)) {
        try {
            const content = readFileSync(settingsFile, "utf-8");
            const settings = JSON.parse(content);
            if (settings.statusline) {
                return mergeWithDefaults({
                    ...legacyConfig,
                    ...settings.statusline,
                    elements: mergeElements(legacyConfig?.elements, settings.statusline.elements),
                    thresholds: mergeThresholds(legacyConfig?.thresholds, settings.statusline.thresholds),
                    contextLimitWarning: mergeContextLimitWarning(legacyConfig?.contextLimitWarning, settings.statusline.contextLimitWarning),
                    locale: isHudLocale(settings.statusline.locale)
                        ? settings.statusline.locale
                        : legacyConfig?.locale,
                    labels: {
                        ...sanitizeHudLabels(legacyConfig?.labels),
                        ...sanitizeHudLabels(settings.statusline.labels),
                    },
                });
            }
        }
        catch (error) {
            console.error("[HUD] Failed to read settings.json:", error instanceof Error ? error.message : error);
        }
    }
    if (legacyConfig) {
        return mergeWithDefaults(legacyConfig);
    }
    return DEFAULT_HUD_CONFIG;
}
/**
 * Merge partial config with defaults
 */
function mergeWithDefaults(config) {
    const preset = config.preset ?? DEFAULT_HUD_CONFIG.preset;
    const presetElements = PRESET_CONFIGS[preset] ?? {};
    const locale = isHudLocale(config.locale)
        ? config.locale
        : DEFAULT_HUD_CONFIG.locale;
    return {
        preset,
        locale,
        labels: resolveHudLabels(locale, config.labels),
        elements: {
            ...DEFAULT_HUD_CONFIG.elements, // Base defaults
            ...presetElements, // Preset overrides
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
