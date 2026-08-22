/**
 * HUD - Main Renderer
 *
 * Composes statusline output from render context.
 */
import { DEFAULT_HUD_CONFIG, DEFAULT_ELEMENT_ORDER, DEFAULT_HUD_LABELS } from "./types.js";
import { paint, PALETTE } from "./colors.js";
import { stringWidth, getCharWidth } from "../lib/string-width.js";
import { renderContext, renderContextWithBar } from "./elements/context.js";
import { renderRateLimits, renderRateLimitsWithBar, renderRateLimitsError } from "./elements/limits.js";
import { renderSession } from "./elements/session.js";
import { renderTokenUsage } from "./elements/token-usage.js";
import { renderGitRepo, renderGitBranch, renderGitStatus } from "./elements/git.js";
import { renderModel } from "./elements/model.js";
import { renderCallCounts } from "./elements/call-counts.js";
/**
 * ANSI escape sequence regex (matches SGR and other CSI sequences).
 * Used to skip escape codes when measuring/truncating visible width.
 */
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const PLAIN_SEPARATOR = " | ";
// Tint the " | " separator with the active palette's hairline slate.
const DIM_SEPARATOR = paint(PALETTE.sep, PLAIN_SEPARATOR);
function buildMainElementOrder(elementOrder) {
    if (!Array.isArray(elementOrder) || elementOrder.length === 0) {
        return DEFAULT_ELEMENT_ORDER.main;
    }
    const known = new Set(DEFAULT_ELEMENT_ORDER.main);
    const seen = new Set();
    const configured = elementOrder.filter((name) => {
        if (!known.has(name) || seen.has(name)) {
            return false;
        }
        seen.add(name);
        return true;
    });
    const remaining = DEFAULT_ELEMENT_ORDER.main.filter((name) => !configured.includes(name));
    return [...configured, ...remaining];
}
/**
 * Truncate a single line to a maximum visual width, preserving ANSI escape codes.
 * When the visible content exceeds maxWidth columns, it is truncated with an ellipsis.
 *
 * @param line - The line to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visual width in terminal columns
 * @returns Truncated line that fits within maxWidth visible columns
 */
export function truncateLineToMaxWidth(line, maxWidth) {
    if (maxWidth <= 0)
        return "";
    if (stringWidth(line) <= maxWidth)
        return line;
    const ELLIPSIS = "...";
    const ellipsisWidth = 3;
    const targetWidth = Math.max(0, maxWidth - ellipsisWidth);
    let visibleWidth = 0;
    let result = "";
    let hasAnsi = false;
    let i = 0;
    while (i < line.length) {
        // Check for ANSI escape sequence at current position
        const remaining = line.slice(i);
        const ansiMatch = remaining.match(ANSI_REGEX);
        if (ansiMatch && ansiMatch.index === 0) {
            // Pass through the entire ANSI sequence without counting width
            result += ansiMatch[0];
            hasAnsi = true;
            i += ansiMatch[0].length;
            continue;
        }
        // Read the full code point (handles surrogate pairs for astral-plane chars like emoji)
        const codePoint = line.codePointAt(i);
        const codeUnits = codePoint > 0xffff ? 2 : 1;
        const char = line.slice(i, i + codeUnits);
        const charWidth = getCharWidth(char);
        if (visibleWidth + charWidth > targetWidth)
            break;
        result += char;
        visibleWidth += charWidth;
        i += codeUnits;
    }
    // Append ANSI reset before ellipsis if any escape codes were seen,
    // to prevent color/style bleed into subsequent terminal output
    const reset = hasAnsi ? "\x1b[0m" : "";
    return result + reset + ELLIPSIS;
}
/**
 * Wrap a single line at HUD separator boundaries so each wrapped line
 * fits within maxWidth visible columns.
 *
 * Falls back to truncation when:
 * - no separator is present
 * - any single segment exceeds maxWidth
 */
function wrapLineToMaxWidth(line, maxWidth) {
    if (maxWidth <= 0)
        return [""];
    if (stringWidth(line) <= maxWidth)
        return [line];
    const separator = line.includes(DIM_SEPARATOR)
        ? DIM_SEPARATOR
        : line.includes(PLAIN_SEPARATOR)
            ? PLAIN_SEPARATOR
            : null;
    if (!separator) {
        return [truncateLineToMaxWidth(line, maxWidth)];
    }
    const segments = line.split(separator);
    if (segments.length <= 1) {
        return [truncateLineToMaxWidth(line, maxWidth)];
    }
    const wrapped = [];
    let current = segments[0] ?? "";
    for (let i = 1; i < segments.length; i += 1) {
        const nextSegment = segments[i] ?? "";
        const candidate = `${current}${separator}${nextSegment}`;
        if (stringWidth(candidate) <= maxWidth) {
            current = candidate;
            continue;
        }
        if (stringWidth(current) > maxWidth) {
            wrapped.push(truncateLineToMaxWidth(current, maxWidth));
        }
        else {
            wrapped.push(current);
        }
        current = nextSegment;
    }
    if (stringWidth(current) > maxWidth) {
        wrapped.push(truncateLineToMaxWidth(current, maxWidth));
    }
    else {
        wrapped.push(current);
    }
    return wrapped;
}
/**
 * Apply maxWidth behavior by mode.
 */
function applyMaxWidthByMode(lines, maxWidth, wrapMode) {
    if (!maxWidth || maxWidth <= 0)
        return lines;
    if (wrapMode === "wrap") {
        return lines.flatMap((line) => wrapLineToMaxWidth(line, maxWidth));
    }
    return lines.map((line) => truncateLineToMaxWidth(line, maxWidth));
}
/**
 * Limit output lines to prevent input field shrinkage (Issue #222).
 * Trims lines from the end while preserving the first (header) line.
 *
 * @param lines - Array of output lines
 * @param maxLines - Maximum number of lines to output (uses DEFAULT_HUD_CONFIG if not specified)
 * @returns Trimmed array of lines
 */
export function limitOutputLines(lines, maxLines) {
    const limit = Math.max(1, maxLines ?? DEFAULT_HUD_CONFIG.elements.maxOutputLines);
    if (lines.length <= limit) {
        return lines;
    }
    const truncatedCount = lines.length - limit + 1;
    return [...lines.slice(0, limit - 1), `... (+${truncatedCount} lines)`];
}
/**
 * Render the complete statusline (single or multi-line)
 */
export async function render(context, config) {
    const { elements: enabledElements } = config;
    const hudLabels = config.labels ?? DEFAULT_HUD_LABELS;
    // ── Render all elements into maps ──────────────────────────────────
    // Each element is rendered independently and stored by name.
    // The layout (or DEFAULT_ELEMENT_ORDER) determines final ordering.
    const rendered = new Map();
    // -- main-line elements --
    if (enabledElements.gitRepo) {
        const gitRepoElement = renderGitRepo(context.cwd);
        if (gitRepoElement)
            rendered.set("gitRepo", gitRepoElement);
    }
    if (enabledElements.gitBranch) {
        const gitBranchElement = renderGitBranch(context.cwd);
        if (gitBranchElement)
            rendered.set("gitBranch", gitBranchElement);
    }
    if (enabledElements.gitStatus) {
        const gitStatusElement = renderGitStatus(context.cwd, hudLabels);
        if (gitStatusElement)
            rendered.set("gitStatus", gitStatusElement);
    }
    const modelSource = enabledElements.modelFormat === 'full'
        ? context.modelId ?? context.modelName
        : context.modelName;
    if (enabledElements.model && modelSource) {
        // Effort level (max|xhigh|high|medium|low) is folded into the model element.
        const effortLevel = enabledElements.effort !== false ? context.effortLevel : null;
        const modelElement = renderModel(modelSource, enabledElements.modelFormat, effortLevel);
        if (modelElement)
            rendered.set("model", modelElement);
    }

    // show the working-folder path here (replaces the former version label),
    // shortening the $HOME prefix to ~ to keep it compact.
    if (enabledElements.pathLabel && context.cwd) {
        const home = process.env.HOME || process.env.USERPROFILE || "";
        const shortCwd = home && (context.cwd === home || context.cwd.startsWith(home + "/"))
            ? "~" + context.cwd.slice(home.length)
            : context.cwd;
        // Same bold path text, tinted with the palette's soft slate.
        rendered.set("pathLabel", `\x1b[1m${paint(PALETTE.text, shortCwd)}`);
    }
    // Rate limits (5h and weekly) - data takes priority over error indicator.
    if (enabledElements.rateLimits && context.rateLimitsResult) {
        if (context.rateLimitsResult.rateLimits) {
            const stale = context.rateLimitsResult.stale;
            const snThreshold = config.thresholds?.sonnetWeeklyVisibility ?? 80;
            const limits = enabledElements.useBars
                ? renderRateLimitsWithBar(context.rateLimitsResult.rateLimits, undefined, stale, snThreshold)
                : renderRateLimits(context.rateLimitsResult.rateLimits, stale, snThreshold);
            if (limits)
                rendered.set("rateLimits", limits);
        }
        else {
            const errorIndicator = renderRateLimitsError(context.rateLimitsResult);
            if (errorIndicator)
                rendered.set("rateLimits", errorIndicator);
        }
    }
    if (enabledElements.sessionHealth && context.sessionHealth) {
        const session = renderSession(context.sessionHealth);
        if (session)
            rendered.set("session", session);
    }
    if (enabledElements.showTokens === true) {
        const tokenUsage = renderTokenUsage(context.sessionTotalTokens, hudLabels);
        if (tokenUsage)
            rendered.set("tokens", tokenUsage);
    }
    if (enabledElements.contextBar) {
        const ctx = enabledElements.useBars
            ? renderContextWithBar(context.contextPercent, config.thresholds, 10, hudLabels)
            : renderContext(context.contextPercent, config.thresholds, hudLabels);
        if (ctx)
            rendered.set("contextBar", ctx);
    }
    const showCounts = enabledElements.showCallCounts ?? true;
    if (showCounts) {
        const counts = renderCallCounts(context.toolCallCount, context.agentCallCount, context.skillCallCount, enabledElements.callCountsFormat ?? 'auto', hudLabels);
        if (counts)
            rendered.set("callCounts", counts);
    }
    // ── Assemble output (single line) ──────────────────────────────────
    const safeArray = (v, fallback) => Array.isArray(v) ? v : fallback;
    // Single-line HUD: only the `main` zone renders. `layout.main` is the advanced
    // authoritative ordering control; `elementOrder` is a convenience alias for it.
    const mainOrder = safeArray(config.layout?.main, buildMainElementOrder(config.elementOrder));
    /** Collect inline elements in layout order. */
    function collectInline(order) {
        const result = [];
        for (const name of order) {
            const el = rendered.get(name);
            if (el)
                result.push(el);
        }
        return result;
    }
    const elements = collectInline(mainOrder);
    // Compose output (single line)
    const headerLine = elements.length > 0 ? elements.join(DIM_SEPARATOR) : null;
    const outputLines = headerLine ? [headerLine] : [];
    const widthAdjustedLines = applyMaxWidthByMode(outputLines, config.maxWidth, config.wrapMode);
    // Apply max output line limit after wrapping so wrapped output still respects maxOutputLines.
    const limitedLines = limitOutputLines(widthAdjustedLines, config.elements.maxOutputLines);
    // Ensure line-limit indicator and all other lines still respect maxWidth.
    const finalLines = config.maxWidth && config.maxWidth > 0
        ? limitedLines.map((line) => truncateLineToMaxWidth(line, config.maxWidth))
        : limitedLines;
    return finalLines.join("\n");
}
