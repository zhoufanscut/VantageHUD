/**
 * Atomic file writes for the HUD, durable on request.
 * Self-contained module with no external dependencies.
 *
 * Two different guarantees, and only the first is the default:
 *
 * - **Atomic** (always): unique temp file, exclusive create, rename(2). A
 *   reader in another process — a concurrent render, another session, the
 *   shell's `[ -s ] && cat` — sees either the old file or the new one, never a
 *   partial one. rename alone gives this; fsync adds nothing to it.
 * - **Durable** (`{ durable: true }`): fsync the file before the rename and
 *   the directory after, so the new content survives a power loss or kernel
 *   crash. Only that: a killed *process* loses nothing either way, since the
 *   data is already in the page cache.
 *
 * Most HUD files are caches the next frame rebuilds, and every reader treats
 * a missing, empty or unparsable one as a miss (a rescan, a re-render), so
 * they skip the two fsyncs: an idle frame writes two files, and their four
 * fsyncs took ~10 ms of a ~120 ms frame on ext4. A write whose loss would cost
 * more than a rebuild (a backoff record: the usage cache's, the status memo's)
 * opts in.
 */
import * as fsSync from "fs";
import * as path from "path";
let uniqueSeq = 0;
/**
 * A name fragment no other live writer is using: pid + time + a per-process
 * counter, plus a little randomness for PID namespaces (containers) that share
 * a cache dir. Not crypto.randomUUID: that needs Node 14.17, and the ESM
 * `crypto` namespace costs ~6 ms per render to build (measured, Node 24). The
 * temp files are opened O_EXCL ('wx') anyway, so a clash fails one write
 * rather than mixing two.
 */
export function uniqueToken() {
    uniqueSeq += 1;
    return `${process.pid.toString(36)}.${Date.now().toString(36)}.${uniqueSeq.toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
}
/**
 * Create directory recursively (inline implementation).
 * Ensures parent directories exist before creating the target directory.
 *
 * @param dir Directory path to create
 */
export function ensureDirSync(dir) {
    if (fsSync.existsSync(dir)) {
        return;
    }
    try {
        fsSync.mkdirSync(dir, { recursive: true });
    }
    catch (err) {
        // If directory was created by another process between exists check and mkdir,
        // that's fine - verify it exists now
        if (err.code === "EEXIST") {
            return;
        }
        throw err;
    }
}
/**
 * Write string data atomically to a file (synchronous version).
 * Uses temp file + atomic rename; fsyncs only when `durable` (see header).
 *
 * @param filePath Target file path
 * @param content String content to write
 * @param [options.durable=false] fsync the file and its directory
 * @throws Error if write operation fails
 */
export function atomicWriteFileSync(filePath, content, { durable = false } = {}) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tempPath = path.join(dir, `.${base}.tmp.${uniqueToken()}`);
    let fd = null;
    let success = false;
    try {
        // Ensure parent directory exists
        ensureDirSync(dir);
        // Open temp file with exclusive creation (O_CREAT | O_EXCL | O_WRONLY)
        fd = fsSync.openSync(tempPath, "wx", 0o600);
        // Write content. writeFileSync loops until every byte is written and
        // throws otherwise; a bare writeSync is one write(2), whose short count
        // (disk filling up) would be renamed into place truncated.
        fsSync.writeFileSync(fd, content, "utf-8");
        // Sync file data to disk before rename, so a crash cannot leave the
        // rename durable and the data not (a zero-length file).
        if (durable) {
            fsSync.fsyncSync(fd);
        }
        // Close before rename
        fsSync.closeSync(fd);
        fd = null;
        // Atomic rename - replaces target file if it exists
        fsSync.renameSync(tempPath, filePath);
        success = true;
        // Best-effort directory fsync to ensure rename is durable
        if (durable) {
            try {
                const dirFd = fsSync.openSync(dir, "r");
                try {
                    fsSync.fsyncSync(dirFd);
                }
                finally {
                    fsSync.closeSync(dirFd);
                }
            }
            catch {
                // Some platforms don't support directory fsync - that's okay
            }
        }
    }
    finally {
        // Close fd if still open
        if (fd !== null) {
            try {
                fsSync.closeSync(fd);
            }
            catch {
                // Ignore close errors
            }
        }
        // Clean up temp file on error
        if (!success) {
            try {
                fsSync.unlinkSync(tempPath);
            }
            catch {
                // Ignore cleanup errors
            }
        }
    }
}
/**
 * Atomically put an empty file at `filePath` whose mtime is `mtimeSec` (epoch
 * seconds): the mtime is set on the temp file before the rename, so no reader
 * ever sees it carrying the current time instead. Used for statusline.sh's
 * deadline file, which the shell compares with `-ot` at no fork cost.
 *
 * @param filePath Target file path
 * @param mtimeSec Modification (and access) time, in epoch seconds
 * @throws Error if any step fails
 */
export function atomicTouchSync(filePath, mtimeSec) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tempPath = path.join(dir, `.${base}.tmp.${uniqueToken()}`);
    let success = false;
    try {
        ensureDirSync(dir);
        fsSync.closeSync(fsSync.openSync(tempPath, "wx", 0o600));
        fsSync.utimesSync(tempPath, mtimeSec, mtimeSec);
        fsSync.renameSync(tempPath, filePath);
        success = true;
    }
    finally {
        if (!success) {
            try {
                fsSync.unlinkSync(tempPath);
            }
            catch {
                // Ignore cleanup errors
            }
        }
    }
}
/**
 * Write JSON data atomically to a file (synchronous version).
 * Uses temp file + atomic rename; fsyncs only when `durable` (see header).
 *
 * @param filePath Target file path
 * @param data Data to serialize as JSON
 * @param [options] Passed to atomicWriteFileSync (`durable`)
 * @throws Error if JSON serialization fails or write operation fails
 */
export function atomicWriteJsonSync(filePath, data, options) {
    const jsonContent = JSON.stringify(data, null, 2);
    atomicWriteFileSync(filePath, jsonContent, options);
}
