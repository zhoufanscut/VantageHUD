/**
 * HUD Type Definitions
 *
 * Type definitions for the HUD state, configuration, and rendering.
 */
export const DEFAULT_HUD_LABELS = {
    context: 'ctx',
    tokens: 'token',
    tool: 'T',
    agent: 'A',
    skill: 'S',
    background: 'bg',
    thinking: 'thinking',
    model: 'Model',
    staged: '+',
    modified: '!',
    untracked: '?',
    ahead: '⇡',
    behind: '⇣',
};
export const HUD_LOCALE_LABELS = {
    en: DEFAULT_HUD_LABELS,
    'zh-CN': {
        context: '上下文',
        tokens: '令牌',
        tool: '工具',
        agent: '智能体',
        skill: '技能',
        background: '后台',
        thinking: '思考',
        model: '模型',
        staged: '已暂存',
        modified: '已修改',
        untracked: '未跟踪',
        ahead: '领先',
        behind: '落后',
    },
};
export const HUD_LABEL_KEYS = Object.freeze(Object.keys(DEFAULT_HUD_LABELS));
export function isHudLocale(value) {
    return value === 'en' || value === 'zh-CN';
}
export function sanitizeHudLabels(labels) {
    if (!labels || typeof labels !== 'object')
        return {};
    const sanitized = {};
    for (const key of HUD_LABEL_KEYS) {
        const value = labels[key];
        if (typeof value === 'string' && value.length > 0) {
            sanitized[key] = value;
        }
    }
    return sanitized;
}
export function resolveHudLabels(locale, labels) {
    return {
        ...DEFAULT_HUD_LABELS,
        ...(isHudLocale(locale) ? HUD_LOCALE_LABELS[locale] : {}),
        ...sanitizeHudLabels(labels),
    };
}
/**
 * Default element order for the single-line HUD (the `main` zone).
 * Used as fallback when no layout is configured.
 */
export const DEFAULT_ELEMENT_ORDER = {
    main: [
        'pathLabel', 'model', 'rateLimits',
        'contextBar', 'tokens', 'session', 'promptTime',
        'agents', 'background',
        'callCounts', 'gitRepo', 'gitBranch', 'gitStatus',
    ],
};
export const DEFAULT_HUD_USAGE_POLL_INTERVAL_MS = 90 * 1000;
export const DEFAULT_HUD_CONFIG = {
    locale: 'en',
    // Color theme — DOCUMENTATION ONLY (not consumed at runtime). Registered
    // palettes live in `themes.js` ('aurora' | 'ember'); the active palette is
    // resolved there at import (HUD_THEME env > config.json `theme`
    // > `DEFAULT_THEME`), since elements freeze their colors before the runtime
    // config is read. The authoritative default is `DEFAULT_THEME` in themes.js
    // — keep this in sync with it. Read the resolved name via `ACTIVE_THEME_NAME`.
    theme: 'aurora',
    labels: DEFAULT_HUD_LABELS,
    elements: {
        // ── Display elements, in render order (mirrors DEFAULT_ELEMENT_ORDER.main) ──
        pathLabel: true,
        model: true, // Show only when Claude Code statusline stdin provides a model
        rateLimits: true, // Show rate limits by default
        contextBar: true,
        showTokens: true, // tokens element — On by default; users can disable in config.json
        sessionHealth: true, // session element
        promptTime: true, // On by default; users can disable in config.json
        agents: false, // Off by default — only "running" mid-turn, which the statusline never re-renders during (see AGENTS.md refresh model)
        backgroundTasks: false, // background element — off by default; state.backgroundTasks is only ever populated by an external hook; none ships
        showCallCounts: true, // callCounts element — tool/agent/skill counts (Issue #710)
        gitRepo: true, // Show repository name by default
        gitBranch: true, // Show branch (and worktree suffix) by default
        gitStatus: true, // Show working-tree status by default
        // ── Behavioral options / sub-toggles (not standalone display elements) ──
        modelFormat: 'versioned', // Preserve model version by default
        effort: true, // Fold the thinking-effort level (high/medium/…) into the model element; set false to hide it
        showSessionDuration: true,
        useBars: false, // Disabled by default for backwards compatibility
        callCountsFormat: 'auto', // Preserve platform-based emoji/ASCII defaults unless explicitly overridden
        maxOutputLines: 4,
        safeMode: true, // Enabled by default to prevent terminal rendering corruption (Issue #346)
    },
    thresholds: {
        contextWarning: 70,
        contextCompactSuggestion: 80,
        contextCritical: 85,
        sonnetWeeklyVisibility: 80, // Hide the Sonnet weekly (sn) bucket until its usage % reaches this (0 = always show)
    },
    staleTaskThresholdMinutes: 10,
    contextLimitWarning: {
        threshold: 80,
        autoCompact: false,
    },
    usageApiPollIntervalMs: DEFAULT_HUD_USAGE_POLL_INTERVAL_MS,
    wrapMode: 'truncate',
};
