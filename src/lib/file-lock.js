/**
 * Cross-process advisory file locking for shared-memory coordination.
 *
 * Uses O_CREAT|O_EXCL (exclusive-create) for atomic lock acquisition.
 * The kernel guarantees at most one process succeeds in creating the file.
 * Includes PID-based stale lock detection and automatic reaping.
 *
 * Reaping is serialized through a second exclusive file (`<lock>.reap`) and
 * staleness is re-checked while holding it. Without that, two processes that
 * both judged one stale lock dead could each unlink it, the later one
 * deleting the fresh lock the earlier one had just taken, and both would run
 * as holders (reproduced: up to 7 concurrent holders out of 8 processes).
 * Each lock also carries a random nonce, so a holder only ever removes its
 * own lock file.
 */
import { openSync, closeSync, unlinkSync, writeFileSync, readFileSync, statSync, constants as fsConstants, } from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { ensureDirSync } from "./atomic-write.js";
import { isProcessAlive } from "./platform.js";
// ============================================================================
// Constants
// ============================================================================
const DEFAULT_STALE_LOCK_MS = 30_000;
// Past this many staleLockMs a lock is reaped even if its PID looks alive: the
// PID may have been reused (quickly on Windows), or belong to another user
// (EPERM reads as alive). Holders do bounded work, so a live one never gets
// near it.
const MAX_LOCK_AGE_FACTOR = 4;
// A reaper holds `<lock>.reap` for microseconds; one older than this was left
// by a reaper that died mid-reap and would otherwise block reaping for good.
const REAP_ORPHAN_MS = 5_000;
// ============================================================================
// Internal helpers
// ============================================================================
/**
 * Check if an existing lock file is stale.
 *
 * A lock is stale when older than staleLockMs AND its PID is dead, or older
 * than MAX_LOCK_AGE_FACTOR * staleLockMs whatever the PID, or dated more than
 * staleLockMs in the future (a clock stepped back). The age comes from the
 * payload's timestamp — written with this machine's clock — and falls back to
 * the file's mtime when the payload is missing or malformed.
 */
function isLockStale(lockPath, staleLockMs) {
    let mtimeMs;
    try {
        mtimeMs = statSync(lockPath).mtimeMs;
    }
    catch {
        // Lock file disappeared -- not stale, just gone
        return false;
    }
    let payload = null;
    try {
        payload = JSON.parse(readFileSync(lockPath, "utf-8"));
    }
    catch {
        // Unreadable, malformed or still being written -- judge by mtime alone
    }
    const startedAt = payload && Number.isFinite(payload.timestamp) ? payload.timestamp : mtimeMs;
    const ageMs = Date.now() - startedAt;
    if (ageMs < -staleLockMs)
        return true;
    if (ageMs < staleLockMs)
        return false;
    if (ageMs >= MAX_LOCK_AGE_FACTOR * staleLockMs)
        return true;
    if (payload && payload.pid && isProcessAlive(payload.pid))
        return false;
    return true;
}
/**
 * Derive the lock file path from a data file path.
 * e.g. /path/to/data.json -> /path/to/data.json.lock
 */
export function lockPathFor(filePath) {
    return filePath + ".lock";
}
/**
 * Create the lock file exclusively and write its payload. Throws EEXIST when
 * the lock is held; any other failure removes the half-made file and rethrows.
 */
function createLock(lockPath) {
    const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    const nonce = crypto.randomUUID();
    try {
        // writeFileSync loops until every byte is written (writeSync may not)
        writeFileSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now(), nonce }), "utf-8");
    }
    catch (writeErr) {
        try {
            closeSync(fd);
        }
        catch { /* already closed */ }
        try {
            unlinkSync(lockPath);
        }
        catch { /* best effort */ }
        throw writeErr;
    }
    return { fd, path: lockPath, nonce };
}
// ============================================================================
// Synchronous API
// ============================================================================
/**
 * Try to acquire an exclusive file lock (synchronous, single attempt).
 *
 * Creates a lock file adjacent to the target using O_CREAT|O_EXCL.
 * On EEXIST, checks for staleness, reaps a stale lock and retries once.
 *
 * @returns LockHandle on success, null if lock is held
 */
function tryAcquireSync(lockPath, staleLockMs) {
    ensureDirSync(path.dirname(lockPath));
    try {
        return createLock(lockPath);
    }
    catch (err) {
        if (!err || err.code !== "EEXIST")
            throw err;
    }
    // Lock file exists — check if stale (cheap pre-check outside the reap lock)
    if (!isLockStale(lockPath, staleLockMs))
        return null;
    return reapAndAcquire(lockPath, staleLockMs);
}
/**
 * Reap a stale lock and take it, holding `<lock>.reap` throughout so only one
 * process reaps at a time. Staleness is re-checked under it: a process that
 * judged the lock stale just before another reaped and re-took it now sees the
 * fresh lock and backs off instead of deleting it.
 *
 * @returns LockHandle on success, null if the lock is held or being reaped
 */
function reapAndAcquire(lockPath, staleLockMs) {
    const reapPath = lockPath + ".reap";
    try {
        closeSync(openSync(reapPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600));
    }
    catch {
        // Another process is reaping. Clear an orphan so the next try can.
        try {
            if (Math.abs(Date.now() - statSync(reapPath).mtimeMs) > REAP_ORPHAN_MS)
                unlinkSync(reapPath);
        }
        catch { /* gone already */ }
        return null;
    }
    try {
        if (!isLockStale(lockPath, staleLockMs))
            return null;
        try {
            unlinkSync(lockPath);
        }
        catch { /* already gone */ }
        try {
            return createLock(lockPath);
        }
        catch {
            // A first-attempt acquirer slipped in after the unlink — it holds it
            return null;
        }
    }
    finally {
        try {
            unlinkSync(reapPath);
        }
        catch { /* best effort */ }
    }
}
/**
 * Release a previously acquired file lock (synchronous). The file is removed
 * only while it still carries this handle's nonce: if the lock was reaped and
 * re-taken by another process, that process's lock is left alone.
 */
function releaseFileLockSync(handle) {
    try {
        closeSync(handle.fd);
    }
    catch {
        /* already closed */
    }
    try {
        const payload = JSON.parse(readFileSync(handle.path, "utf-8"));
        if (payload && payload.nonce === handle.nonce)
            unlinkSync(handle.path);
    }
    catch {
        /* already removed, or not ours */
    }
}
// ============================================================================
// Asynchronous API
// ============================================================================
/**
 * Acquire an exclusive file lock: a single attempt, no waiting. Callers serve
 * cached data when the lock is held rather than queue behind it.
 *
 * @param lockPath Path for the lock file
 * @param opts Lock options ({ staleLockMs })
 * @returns FileLockHandle on success, null if the lock is held
 */
export async function acquireFileLock(lockPath, opts) {
    return tryAcquireSync(lockPath, opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
}
/**
 * Release a previously acquired file lock (async-compatible, delegates to sync).
 */
export function releaseFileLock(handle) {
    releaseFileLockSync(handle);
}
/**
 * Execute an async function while holding an exclusive file lock.
 *
 * @param lockPath Path for the lock file
 * @param fn Async function to execute under lock
 * @param opts Lock options
 * @returns The function's return value
 * @throws Error if the lock cannot be acquired
 */
export async function withFileLock(lockPath, fn, opts) {
    const handle = await acquireFileLock(lockPath, opts);
    if (!handle) {
        throw new Error(`Failed to acquire file lock: ${lockPath}`);
    }
    try {
        return await fn();
    }
    finally {
        releaseFileLock(handle);
    }
}
