/**
 * HUD - Output Sanitizer
 *
 * Sanitizes HUD output to prevent terminal rendering corruption
 * when Claude Code's Ink renderer is concurrently updating the display.
 *
 * oh-my-claudecode#346 (the project this HUD grew out of): terminal rendering corruption during AI generation with HUD enabled.
 *
 * Root cause: Multi-line output containing ANSI escape sequences and
 * variable-width Unicode characters (progress bar blocks) can interfere
 * with Claude Code's terminal cursor positioning during active rendering.
 *
 * This module provides:
 * - Terminal control sequence stripping (preserving color/style codes)
 * - Unicode block character replacement with ASCII equivalents
 * - Per-line trailing-whitespace trim (newlines are kept; the line count is
 *   capped by render.js#limitOutputLines, not here)
 */
// Matches CSI sequences that are NOT SGR (color/style) codes
// SGR sequences end with 'm' and should be preserved for color output
// Other CSI sequences (cursor movement, clear screen, etc.) should be stripped:
// - H: cursor position, J: erase display, K: erase line
// - A/B/C/D: cursor up/down/forward/back, etc.
// - ?25l/?25h: cursor visibility (private sequences with ? prefix)
const CSI_NON_SGR_REGEX = /\x1b\[\??[0-9;]*[A-LN-Za-ln-z]/g;
// Matches OSC sequences (ESC]...BEL) - operating system commands
const OSC_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Matches simple escape sequences (ESC + single char, but not [ or ])
const SIMPLE_ESC_REGEX = /\x1b[^[\]]/g;
/**
 * Strip terminal control ANSI sequences while preserving color/style (SGR) codes.
 *
 * SGR (Select Graphic Rendition) sequences end with 'm' and control text appearance:
 * - Colors: \x1b[32m (green), \x1b[31m (red), etc.
 * - Styles: \x1b[1m (bold), \x1b[0m (reset), etc.
 *
 * Other CSI sequences are stripped as they can interfere with terminal rendering:
 * - Cursor positioning: \x1b[H, \x1b[10;20H
 * - Erase commands: \x1b[2J (clear screen), \x1b[K (erase line)
 * - Cursor movement: \x1b[A (up), \x1b[B (down), etc.
 * - Cursor visibility: \x1b[?25l (hide), \x1b[?25h (show)
 */
export function stripControlSequences(text) {
    return text
        .replace(CSI_NON_SGR_REGEX, '') // Strip non-SGR CSI sequences
        .replace(OSC_REGEX, '') // Strip OSC sequences
        .replace(SIMPLE_ESC_REGEX, ''); // Strip simple escape sequences
}
const TEXT_CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;
/**
 * Replace every C0/C1 control character, ESC included, with `?`.
 *
 * For outside text painted into a fragment: the path and model name from the
 * payload, and repository names, branches and worktree names read from git or
 * svn. A percent-decoded SVN URL can carry `%1B`, `%07` or `%0A`, and render.js
 * keeps ESC in fragments (its own SGR codes need it), so without this an OSC
 * or a newline from a repository name reached the terminal.
 */
export function cleanText(text) {
    return String(text).replace(TEXT_CONTROLS, '?');
}
/**
 * Replace variable-width Unicode block characters with fixed-width ASCII equivalents.
 * Targets characters commonly used in progress bars that have inconsistent
 * terminal width across different terminal emulators.
 */
export function replaceUnicodeBlocks(text) {
    return text
        .replace(/█/g, '#')
        .replace(/░/g, '-')
        .replace(/▓/g, '=')
        .replace(/▒/g, '-');
}
/**
 * Sanitize HUD output for safe terminal rendering.
 *
 * Processing steps:
 * 1. Strips terminal control sequences while preserving color/style SGR codes
 * 2. Replaces Unicode block characters with ASCII (prevents width miscalculation)
 * 3. Preserves multi-line output (newlines are kept for proper HUD rendering)
 * 4. Trims excessive whitespace within lines
 *
 * Note: newlines are preserved. The HUD renders one line, but `wrapMode: "wrap"`
 * can break it into several, and collapsing them here would undo that.
 *
 * @param output - Raw HUD output (may contain ANSI codes and newlines)
 * @returns Sanitized output safe for concurrent terminal rendering
 */
export function sanitizeOutput(output) {
    // Step 1: Strip terminal control sequences (preserving color/style SGR codes)
    let sanitized = stripControlSequences(output);
    // Step 2: Replace variable-width Unicode with ASCII
    sanitized = replaceUnicodeBlocks(sanitized);
    // Step 3: Preserve multi-line output, just trim each line
    // Do NOT collapse to a single line - a wrapped line keeps its breaks
    const lines = sanitized.split('\n').map(line => line.trimEnd());
    sanitized = lines.join('\n');
    // Step 4: Remove leading/trailing empty lines
    sanitized = sanitized.replace(/^\n+|\n+$/g, '');
    return sanitized;
}
