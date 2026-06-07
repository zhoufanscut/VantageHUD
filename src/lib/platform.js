/**
 * Platform Detection and Utilities
 * Central module for all platform-specific code (WSL detection, process checks).
 */
import { readFileSync } from 'fs';
/**
 * Check if running inside WSL (Windows Subsystem for Linux).
 * Checks WSLENV env var OR /proc/version containing "microsoft".
 */
export function isWSL() {
    if (process.env.WSLENV !== undefined) {
        return true;
    }
    try {
        const procVersion = readFileSync('/proc/version', 'utf8');
        return procVersion.toLowerCase().includes('microsoft');
    }
    catch {
        return false;
    }
}
/**
 * Check if a process is alive.
 * Works cross-platform by attempting signal 0.
 * EPERM means the process exists but we lack permission to signal it.
 */
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
            return true;
        }
        return false;
    }
}
