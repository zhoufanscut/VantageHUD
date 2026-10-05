/**
 * HUD - Main Renderer
 *
 * Composes statusline output from render context.
 */
import { DEFAULT_HUD_CONFIG, DEFAULT_ELEMENT_ORDER, DEFAULT_HUD_LABELS } from "./types.js";
import { paint, paintWarn, PALETTE } from "./colors.js";
import { stringWidth, getCharWidth } from "../lib/string-width.js";
import { renderContext, renderContextWithBar } from "./elements/context.js";
import { renderRateLimits, renderRateLimitsWithBar, renderRateLimitsError, renderSpendLimit } from "./elements/limits.js";
import { renderSession } from "./elements/session.js";
import { renderTokenUsage } from "./elements/token-usage.js";
import { renderGitRepo, renderGitBranch, renderGitStatus } from "./elements/git.js";
import { renderSvnRepo, renderSvnBranch, renderSvnStatus, isSvnWorkingCopy } from "./elements/svn.js";
import { getWorktreeRoot } from "../lib/worktree-paths.js";
import { cleanText } from "./sanitize.js";
import { renderModel } from "./elements/model.js";
import { renderCallCounts } from "./elements/call-counts.js";
import { renderPromptCache } from "./elements/prompt-cache.js";
/**
 * ANSI escape sequence regex (matches SGR and other CSI sequences).
 * Used to skip escape codes when measuring/truncating visible width.
 */
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const PLAIN_SEPARATOR = " | ";
// C0/C1 controls. A fragment may carry ESC (its own SGR colors) and nothing
// else: a newline, CR or BEL from a directory, model or repo name would split
// the single line or move the cursor, and width math counts each as a column.
const FRAGMENT_CONTROLS = /[\x00-\x1a\x1c-\x1f\x7f-\x9f]/g;
// Payload text painted as-is (path, model name) goes through cleanText
// (sanitize.js), which replaces ESC too: a raw escape there would be the
// payload's, not ours.
/**
 * Shorten a `home` prefix of `cwd` to `~`. Separators are compared as `/`
 * either way round (Windows paths arrive as `C:\Users\x` from the payload and
 * `C:/Users/x` from git), a trailing separator on HOME is ignored, and on
 * win32 the comparison ignores case. A home that is a filesystem root (`/`,
 * `C:\`) never shortens anything.
 */
export function shortenHomePath(cwd, home) {
    if (!home)
        return cwd;
    const slashes = (p) => p.replace(/\\/g, "/");
    const root = slashes(home).replace(/\/+$/, "");
    if (root === "" || /^[A-Za-z]:$/.test(root))
        return cwd;
    const fold = process.platform === "win32" ? (p) => p.toLowerCase() : (p) => p;
    const path = fold(slashes(cwd));
    const prefix = fold(root);
    if (path === prefix || path.startsWith(prefix + "/"))
        return "~" + cwd.slice(root.length);
    return cwd;
}
// Tint the " | " separator with the active palette's hairline slate.
const DIM_SEPARATOR = paint(PALETTE.sep, PLAIN_SEPARATOR);
/**
 * `layout.main` is authoritative — what it leaves out stays hidden — but a
 * repeated or unknown name is dropped, and an empty list counts as unset: it
 * would print an empty line over the cached good one.
 */
function buildLayoutMainOrder(layoutMain) {
    if (!Array.isArray(layoutMain))
        return null;
    const known = new Set(DEFAULT_ELEMENT_ORDER.main);
    const order = [...new Set(layoutMain)].filter((name) => known.has(name));
    return order.length > 0 ? order : null;
}
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
    // Below 3 columns the ellipsis itself is cut to fit.
    const ELLIPSIS = "...".slice(0, maxWidth);
    const ellipsisWidth = ELLIPSIS.length;
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
 * Limit output lines to prevent input field shrinkage (oh-my-claudecode#222).
 * Trims lines from the end while preserving the first (header) line.
 *
 * @param lines - Array of output lines
 * @param maxLines - Maximum number of lines to output (uses DEFAULT_HUD_CONFIG if not specified)
 * @returns Trimmed array of lines
 */
export function limitOutputLines(lines, maxLines) {
    // A non-numeric limit made every comparison false and left only the
    // "... (+NaN lines)" indicator; fall back to the default instead.
    const requested = Math.floor(Number(maxLines));
    const limit = Number.isFinite(requested) && requested >= 1
        ? requested
        : DEFAULT_HUD_CONFIG.elements.maxOutputLines;
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
    // One element's throw must cost only its own fragment, not the whole
    // line (which index.js would replace with "[HUD] HUD error").
    const put = (name, build) => {
        let fragment = null;
        try {
            fragment = build();
        }
        catch (error) {
            if (process.env.HUD_DEBUG) {
                console.error(`[HUD] ${name} element failed:`, error instanceof Error ? error.message : error);
            }
            return;
        }
        if (fragment)
            rendered.set(name, String(fragment).replace(FRAGMENT_CONTROLS, "?"));
    };
    // -- main-line elements --
    // The three `git*` elements are VCS slots covering both supported systems.
    // The choice is made ONCE, here, rather than per slot: an element-by-element
    // `??` fallback lets the slots disagree — a git clone sitting inside an SVN
    // working copy has no `origin`, so `repo:` would fall through to the SVN
    // project while `branch:` stayed on git, and a *clean* git tree (null
    // status) would fall through to `svn status`, which reports that whole
    // directory as unversioned. Git wins ties; SVN answers only when the
    // directory is not a git worktree at all, and neither answers in a plain
    // directory.
    const wantsVcs = enabledElements.gitRepo || enabledElements.gitBranch || enabledElements.gitStatus;
    // Cheap by construction: one `git rev-parse` for the decision (cached, and
    // already paid by index.js's resolveToWorktreeRoot), and the SVN side is a
    // filesystem walk for `.svn`, so a git checkout never spawns `svn` and an
    // SVN checkout never spawns the git element commands. Outside both, no
    // element command runs at all: three spawns that could only fail. The repo
    // name and worktree suffix come from the payload's `workspace` when Claude
    // Code supplies them (index.js), which spares three more git spawns per
    // frame.
    let vcs = null;
    try {
        if (wantsVcs) {
            vcs = getWorktreeRoot(context.cwd) !== null ? "git"
                : isSvnWorkingCopy(context.cwd) ? "svn" : null;
        }
    }
    catch {
        // Undecidable: the git slots answer (and hide themselves) as before.
        vcs = "git";
    }
    if (enabledElements.gitRepo) {
        // The payload's repo name renders even when rev-parse failed (no git on
        // PATH, a safe.directory refusal): it costs no spawn and was right.
        put("gitRepo", () => vcs === "svn" ? renderSvnRepo(context.cwd)
            : vcs === "git" || context.repoName ? renderGitRepo(context.cwd, context.repoName) : null);
    }
    if (enabledElements.gitBranch && vcs) {
        // `detachedHead` (opt-in, default off): a detached HEAD — rebase,
        // bisect, a checked-out tag — names its commit instead of hiding.
        const branchOptions = { detachedHead: enabledElements.detachedHead === true, labels: hudLabels };
        put("gitBranch", () => vcs === "svn" ? renderSvnBranch(context.cwd) : renderGitBranch(context.cwd, context.worktreeHint, branchOptions));
    }
    if (enabledElements.gitStatus && vcs) {
        put("gitStatus", () => vcs === "svn"
            ? renderSvnStatus(context.cwd, hudLabels, context.sessionKey, context.syncRender)
            : renderGitStatus(context.cwd, hudLabels, context.sessionKey, context.syncRender));
    }
    const modelSource = enabledElements.modelFormat === 'full'
        ? context.modelId ?? context.modelName
        : context.modelName;
    if (enabledElements.model && modelSource) {
        // Effort level (max|xhigh|high|medium|low) is folded into the model element.
        const effortLevel = enabledElements.effort !== false ? context.effortLevel : null;
        put("model", () => renderModel(cleanText(modelSource), enabledElements.modelFormat, effortLevel));
    }

    // show the working-folder path here (replaces the former version label),
    // shortening the $HOME prefix to ~ to keep it compact.
    if (enabledElements.pathLabel && context.cwd) {
        const home = process.env.HOME || process.env.USERPROFILE || "";
        // Same bold path text, tinted with the palette's soft slate.
        put("pathLabel", () => `\x1b[1m${paint(PALETTE.text, cleanText(shortenHomePath(context.cwd, home)))}`);
    }
    // Rate limits (5h and weekly) - data takes priority over error indicator.
    // Two opt-in additions, both off by default: `otherModelWeekly` (per-model
    // weekly buckets beyond sn:/op:, from the usage API) and `spendLimit` (the
    // payload's Claude apps gateway spend limit, appended as `spend:`). Behind
    // a gateway the usage API is skipped, so `spend:` can be the whole element.
    const spendLimit = enabledElements.spendLimit === true ? context.spendLimit : null;
    if (enabledElements.rateLimits && (context.rateLimitsResult || spendLimit)) {
        put("rateLimits", () => {
            let limitsPart = null;
            if (context.rateLimitsResult?.rateLimits) {
                const stale = context.rateLimitsResult.stale;
                const snThreshold = config.thresholds?.sonnetWeeklyVisibility ?? 80;
                const showOtherModels = enabledElements.otherModelWeekly === true;
                limitsPart = enabledElements.useBars
                    ? renderRateLimitsWithBar(context.rateLimitsResult.rateLimits, undefined, stale, snThreshold, showOtherModels)
                    : renderRateLimits(context.rateLimitsResult.rateLimits, stale, snThreshold, showOtherModels);
            }
            else if (context.rateLimitsResult) {
                limitsPart = renderRateLimitsError(context.rateLimitsResult);
            }
            const spendPart = spendLimit
                ? renderSpendLimit(spendLimit, hudLabels.spendLimit, enabledElements.useBars === true)
                : null;
            return [limitsPart, spendPart].filter(Boolean).join(" ") || null;
        });
    }
    if (enabledElements.sessionHealth && context.sessionHealth) {
        put("session", () => renderSession(context.sessionHealth, hudLabels));
    }
    if (enabledElements.showTokens === true) {
        put("tokens", () => renderTokenUsage(context.sessionTotalTokens, hudLabels, context.sessionTokensApproximate));
    }
    if (enabledElements.contextBar) {
        put("contextBar", () => enabledElements.useBars
            ? renderContextWithBar(context.contextPercent, config.thresholds, 10, hudLabels)
            : renderContext(context.contextPercent, config.thresholds, hudLabels));
    }
    // Opt-in (`elements.promptCache`, default false); hidden while the payload
    // has no `prompt_cache` (before the first API response, or caching off).
    if (enabledElements.promptCache === true && context.promptCache) {
        put("promptCache", () => renderPromptCache(context.promptCache, hudLabels));
    }
    const showCounts = enabledElements.showCallCounts ?? true;
    if (showCounts) {
        put("callCounts", () => renderCallCounts(context.toolCallCount, context.agentCallCount, context.skillCallCount, enabledElements.callCountsFormat ?? 'auto', hudLabels));
    }
    // ── Assemble output (single line) ──────────────────────────────────
    // Single-line HUD: only the `main` zone renders. `layout.main` is the advanced
    // authoritative ordering control; `elementOrder` is a convenience alias for it.
    const mainOrder = buildLayoutMainOrder(config.layout?.main) ?? buildMainElementOrder(config.elementOrder);
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
    // config.json exists but did not parse (state.js#readHudConfig): every
    // setting fell back to its default, so say so — first, where truncation
    // cannot cut it. The parser's message is on stderr (HUD_DEBUG=1 to see it).
    if (config.configError)
        elements.unshift(paintWarn("[cfg err]"));
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
