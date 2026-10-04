/**
 * JSON.parse for hand-edited files. Imports nothing, so themes.js can use it
 * at import time without an import cycle.
 */
/**
 * Parse JSON text, ignoring a leading UTF-8 byte-order mark: Windows
 * PowerShell 5.1 (`Set-Content -Encoding UTF8`) and older Notepad write one,
 * and JSON.parse rejects it — which silently threw away the whole config.
 *
 * @param {string} raw
 * @returns {unknown}
 * @throws SyntaxError on invalid JSON
 */
export function parseJsonText(raw) {
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}
