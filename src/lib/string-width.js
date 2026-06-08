/**
 * CJK-aware String Width Utilities
 *
 * Provides functions for calculating visual width of strings containing
 * CJK (Chinese, Japanese, Korean) characters, which are typically displayed
 * as double-width in terminal emulators.
 *
 * This is a lightweight implementation without external dependencies.
 * For full Unicode support, consider using the 'string-width' npm package.
 *
 * Related: Issue #344 - Korean IME input visibility
 */
/**
 * Check if a character code point is a CJK (double-width) character.
 *
 * This covers the main CJK Unicode ranges:
 * - CJK Unified Ideographs
 * - Hangul Syllables
 * - Hiragana and Katakana
 * - Full-width ASCII and punctuation
 * - CJK Compatibility Ideographs
 */
export function isCJKCharacter(codePoint) {
    return (
    // CJK Unified Ideographs (Chinese characters)
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
        // CJK Unified Ideographs Extension A
        (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
        // CJK Unified Ideographs Extension B-F (rare characters)
        (codePoint >= 0x20000 && codePoint <= 0x2ebef) ||
        // CJK Compatibility Ideographs
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        // Hangul Syllables (Korean)
        (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
        // Hangul Jamo (Korean components)
        (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
        // Hangul Compatibility Jamo
        (codePoint >= 0x3130 && codePoint <= 0x318f) ||
        // Hangul Jamo Extended-A
        (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
        // Hangul Jamo Extended-B
        (codePoint >= 0xd7b0 && codePoint <= 0xd7ff) ||
        // Hiragana (Japanese)
        (codePoint >= 0x3040 && codePoint <= 0x309f) ||
        // Katakana (Japanese)
        (codePoint >= 0x30a0 && codePoint <= 0x30ff) ||
        // Katakana Phonetic Extensions
        (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
        // Full-width ASCII variants
        (codePoint >= 0xff01 && codePoint <= 0xff60) ||
        // Full-width punctuation and symbols
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        // CJK Symbols and Punctuation
        (codePoint >= 0x3000 && codePoint <= 0x303f) ||
        // Enclosed CJK Letters and Months
        (codePoint >= 0x3200 && codePoint <= 0x32ff) ||
        // CJK Compatibility
        (codePoint >= 0x3300 && codePoint <= 0x33ff) ||
        // CJK Compatibility Forms
        (codePoint >= 0xfe30 && codePoint <= 0xfe4f));
}
/**
 * Check if a code point is an emoji that terminals render double-width.
 *
 * Unicode marks these East_Asian_Width = Wide (W); modern terminals
 * (SecureCRT included) draw them across two cells. The CJK table above does
 * not cover them, so without this they'd be under-counted as width 1 and the
 * right side of the HUD would drift one column per glyph.
 *
 * The Misc Technical block (U+2300-23FF) is mixed, so only its Wide members
 * are listed explicitly — narrow siblings such as U+23F1 (⏱) and U+23F2 (⏲)
 * deliberately stay width 1.
 */
export function isWideEmoji(codePoint) {
    return (
    // Supplemental emoji planes: emoticons, pictographs, transport,
    // symbols & pictographs A/B — e.g. 🔧 (U+1F527), 🤖 (U+1F916).
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
        // Enclosed supplement, mahjong tiles, dominoes, playing cards.
        (codePoint >= 0x1f000 && codePoint <= 0x1f2ff) ||
        // High Voltage ⚡ (U+26A1), used as the skill icon in call-counts.
        codePoint === 0x26a1 ||
        // Wide members of Misc Technical: ⌚⌛ (U+231A/1B), media transport
        // (U+23E9-23EC), ⏰ alarm clock (U+23F0), ⏳ hourglass (U+23F3).
        codePoint === 0x231a || codePoint === 0x231b ||
        (codePoint >= 0x23e9 && codePoint <= 0x23ec) ||
        codePoint === 0x23f0 || codePoint === 0x23f3);
}
/**
 * Check if a character is a zero-width character.
 * These characters don't contribute to visual width.
 */
export function isZeroWidth(codePoint) {
    return (
    // Zero-width characters
    codePoint === 0x200b || // Zero Width Space
        codePoint === 0x200c || // Zero Width Non-Joiner
        codePoint === 0x200d || // Zero Width Joiner
        codePoint === 0xfeff || // Byte Order Mark / Zero Width No-Break Space
        // Combining diacritical marks (they modify previous character)
        (codePoint >= 0x0300 && codePoint <= 0x036f) ||
        // Combining Diacritical Marks Extended
        (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
        // Combining Diacritical Marks Supplement
        (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
        // Combining Diacritical Marks for Symbols
        (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
        // Combining Half Marks
        (codePoint >= 0xfe20 && codePoint <= 0xfe2f));
}
/**
 * Get the visual width of a single character.
 * - CJK characters: 2 (double-width)
 * - Zero-width characters: 0
 * - Regular ASCII and most others: 1
 */
export function getCharWidth(char) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined)
        return 0;
    if (isZeroWidth(codePoint))
        return 0;
    if (isCJKCharacter(codePoint))
        return 2;
    if (isWideEmoji(codePoint))
        return 2;
    return 1;
}
/**
 * Calculate the visual width of a string in terminal columns.
 * Accounts for CJK double-width characters.
 *
 * Note: This strips ANSI escape codes before calculating width.
 *
 * @param str - The string to measure
 * @returns Visual width in terminal columns
 */
export function stringWidth(str) {
    if (!str)
        return 0;
    // Strip ANSI escape codes
    const stripped = stripAnsi(str);
    let width = 0;
    for (const char of stripped) {
        width += getCharWidth(char);
    }
    return width;
}
/**
 * Strip ANSI escape codes from a string.
 */
export function stripAnsi(str) {
    // ANSI escape code pattern: ESC [ ... m (SGR sequences)
    // Also handles other common sequences
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}
/**
 * Truncate a string to fit within a maximum visual width.
 * CJK-aware: accounts for double-width characters.
 *
 * @param str - The string to truncate
 * @param maxWidth - Maximum visual width in terminal columns
 * @param suffix - Suffix to append if truncated (default: "...")
 * @returns Truncated string that fits within maxWidth
 */
export function truncateToWidth(str, maxWidth, suffix = "...") {
    if (!str || maxWidth <= 0)
        return "";
    const strWidth = stringWidth(str);
    if (strWidth <= maxWidth)
        return str;
    const suffixWidth = stringWidth(suffix);
    const targetWidth = maxWidth - suffixWidth;
    if (targetWidth <= 0) {
        // Can't even fit the suffix, return truncated suffix
        return truncateToWidthNoSuffix(suffix, maxWidth);
    }
    return truncateToWidthNoSuffix(str, targetWidth) + suffix;
}
/**
 * Truncate a string to fit within a maximum visual width without adding suffix.
 * Used internally and when you don't want ellipsis.
 */
function truncateToWidthNoSuffix(str, maxWidth) {
    let width = 0;
    let result = "";
    for (const char of str) {
        const charWidth = getCharWidth(char);
        if (width + charWidth > maxWidth)
            break;
        result += char;
        width += charWidth;
    }
    return result;
}
