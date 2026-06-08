/**
 * Worktree + cache path helpers.
 *
 * Worktree resolution (getWorktreeRoot / resolveToWorktreeRoot /
 * resolveTranscriptPath) is used for cwd display and transcript lookup.
 *
 * All runtime files live flat in a single cache directory
 * (getCacheDir → HUD_CACHE_DIR || <install>/cache) with a `<name>.<session>.json`
 * naming scheme. Nothing is ever written inside a user's project, and the
 * globally-unique session id keeps unrelated sessions (and projects) from
 * colliding — so no per-project subdirectory is needed.
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, realpathSync, readdirSync, statSync } from 'fs';
import { resolve, relative, sep, join, isAbsolute, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getClaudeConfigDir } from './config-dir.js';
/**
 * LRU cache for worktree root lookups to avoid repeated git subprocess calls.
 * Bounded to MAX_WORKTREE_CACHE_SIZE entries to prevent memory growth when
 * alternating between many different cwds (cache thrashing).
 */
const MAX_WORKTREE_CACHE_SIZE = 8;
const worktreeCacheMap = new Map();
/**
 * Get the git worktree root for the current or specified directory.
 * Returns null if not in a git repository.
 */
export function getWorktreeRoot(cwd) {
    const effectiveCwd = cwd || process.cwd();
    // Return cached value if present (LRU: move to end on access)
    if (worktreeCacheMap.has(effectiveCwd)) {
        const root = worktreeCacheMap.get(effectiveCwd);
        // Refresh insertion order for LRU eviction
        worktreeCacheMap.delete(effectiveCwd);
        worktreeCacheMap.set(effectiveCwd, root);
        return root || null;
    }
    try {
        const root = execSync('git rev-parse --show-toplevel', {
            cwd: effectiveCwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000,
        }).trim();
        // Evict oldest entry when at capacity
        if (worktreeCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
            const oldest = worktreeCacheMap.keys().next().value;
            if (oldest !== undefined) {
                worktreeCacheMap.delete(oldest);
            }
        }
        worktreeCacheMap.set(effectiveCwd, root);
        return root;
    }
    catch {
        // Not in a git repository - do NOT cache fallback
        // so that if directory becomes a git repo later, we re-detect
        return null;
    }
}
/**
 * Validate that a path is safe (no traversal attacks).
 *
 * @throws Error if path contains traversal sequences
 */
export function validatePath(inputPath) {
    // Reject explicit path traversal
    if (inputPath.includes('..')) {
        throw new Error(`Invalid path: path traversal not allowed (${inputPath})`);
    }
    // Reject absolute paths - use isAbsolute() for cross-platform coverage
    // Covers: /unix, ~/home, C:\windows, D:/windows, \\UNC
    if (inputPath.startsWith('~') || isAbsolute(inputPath)) {
        throw new Error(`Invalid path: absolute paths not allowed (${inputPath})`);
    }
}
// ============================================================================
// FLAT CACHE PATHS (single dir = HUD_CACHE_DIR || <install>/cache) — matches statusline.sh
// ============================================================================
/**
 * Resolve the shared cache directory. Both the shell wrapper's render cache and
 * the Node HUD's state live here, flat, named `<base>.<session>.json`.
 *
 * The default is the HUD install's own `cache/` folder, derived from this
 * module's location so it follows a relocated install. worktree-paths.js lives
 * at `<hud-install>/src/lib/`, so the install root is two directories up — the
 * same `$SCRIPT_DIR/cache` statusline.sh resolves. `HUD_CACHE_DIR` overrides it
 * (honored by the shell too), so the two layers never diverge.
 */
export function getCacheDir() {
    if (process.env.HUD_CACHE_DIR) {
        return process.env.HUD_CACHE_DIR;
    }
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const hudInstallRoot = resolve(moduleDir, '..', '..');
    return join(hudInstallRoot, 'cache');
}
/**
 * Ensure the shared cache directory exists. Best-effort; tolerates the EEXIST
 * race between concurrent sessions (see atomic-write.js:ensureDirSync).
 */
export function ensureCacheDir() {
    const dir = getCacheDir();
    if (!existsSync(dir)) {
        try {
            mkdirSync(dir, { recursive: true });
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
        }
    }
    return dir;
}
/**
 * Sanitize a session key for use as a filename suffix. Mirrors the shell's
 * `sed 's/[^A-Za-z0-9_.-]/_/g'` (statusline.sh) so Node and the shell agree on
 * the suffix for the same session. Empty/missing keys collapse to `default`.
 */
export function sanitizeSessionKey(sessionKey) {
    const raw = (sessionKey == null ? '' : String(sessionKey)).trim();
    if (!raw) {
        return 'default';
    }
    return raw.replace(/[^A-Za-z0-9_.-]/g, '_');
}
/**
 * Resolve a session-scoped cache file path: `<cacheDir>/<baseName>.<session>.json`.
 *
 * Flat — no per-project or per-session subdirectories. The globally-unique
 * session id keeps unrelated sessions (and projects sharing one install) from
 * colliding, which is also why the stdin cache can no longer be clobbered
 * across sessions.
 */
export function sessionCacheFile(baseName, sessionKey) {
    return join(getCacheDir(), `${baseName}.${sanitizeSessionKey(sessionKey)}.json`);
}
/**
 * List existing `<baseName>.*.json` cache files, most-recently-modified first
 * (absolute paths). Used only as a fallback for readers that have no session
 * key (e.g. a detached watch process); the primary path always passes a key.
 */
export function listSessionCacheFiles(baseName) {
    const dir = getCacheDir();
    if (!existsSync(dir)) {
        return [];
    }
    const prefix = `${baseName}.`;
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile()
            && entry.name.startsWith(prefix)
            && entry.name.endsWith('.json'))
            .map((entry) => join(dir, entry.name))
            .map((path) => {
            try {
                return { path, mtime: statSync(path).mtimeMs };
            }
            catch {
                return { path, mtime: -Infinity };
            }
        })
            .sort((a, b) => b.mtime - a.mtime)
            .map((entry) => entry.path);
    }
    catch {
        return [];
    }
}
/**
 * Resolve a directory path to its git worktree root.
 *
 * Walks up from `directory` using `git rev-parse --show-toplevel`.
 * Falls back to `getWorktreeRoot(process.cwd())`, then `process.cwd()`.
 *
 * Used to derive the cwd shown in the HUD and to resolve transcript paths —
 * not for state location (runtime files live flat under getCacheDir()).
 *
 * @param directory - Any directory inside a git worktree (optional)
 * @returns The worktree root (never a subdirectory)
 */
export function resolveToWorktreeRoot(directory) {
    if (directory) {
        const resolved = resolve(directory);
        const root = getWorktreeRoot(resolved);
        if (root)
            return root;
        console.error('[worktree] non-git directory provided, falling back to process root', {
            directory: resolved,
        });
    }
    // Fallback: derive from process CWD (the MCP server / CLI entry point)
    return getWorktreeRoot(process.cwd()) || process.cwd();
}
// ============================================================================
// TRANSCRIPT PATH RESOLUTION (Issue #1094)
// ============================================================================
/**
 * Resolve a Claude Code transcript path that may be mismatched in worktree sessions.
 *
 * When Claude Code runs inside a worktree (.claude/worktrees/X), it encodes the
 * worktree CWD into the project directory path, creating a transcript_path like:
 *   ~/.claude/projects/-path-to-project--claude-worktrees-X/<session>.jsonl
 *
 * But the actual transcript lives at the original project's path:
 *   ~/.claude/projects/-path-to-project/<session>.jsonl
 *
 * Claude Code encodes `/` and `.` as `-`. The `.claude/worktrees/`
 * segment becomes `-claude-worktrees-`, preceded by a `-` from the path
 * separator, yielding the distinctive `--claude-worktrees-` pattern in the
 * encoded directory name.
 *
 * This function detects the mismatch and resolves to the correct path.
 *
 * @param transcriptPath - The transcript_path from Claude Code hook input
 * @param cwd - Optional CWD for fallback detection
 * @returns The resolved transcript path (original if already correct or no resolution found)
 */
export function resolveTranscriptPath(transcriptPath, cwd) {
    if (!transcriptPath)
        return undefined;
    // Fast path: if the file already exists, no resolution needed
    if (existsSync(transcriptPath))
        return transcriptPath;
    // Strategy 1: Detect worktree-encoded segment in the transcript path itself.
    // The pattern `--claude-worktrees-` appears when Claude Code encodes a CWD
    // containing `/.claude/worktrees/` (separator `/` → `-`, dot `.` → `-`).
    // Strip everything from this pattern to the next `/` to recover the original
    // project directory encoding.
    const worktreeSegmentPattern = /--claude-worktrees-[^/\\]+/;
    if (worktreeSegmentPattern.test(transcriptPath)) {
        const resolved = transcriptPath.replace(worktreeSegmentPattern, '');
        if (existsSync(resolved))
            return resolved;
    }
    // Strategy 2: Use CWD to detect worktree and reconstruct the path.
    // When the CWD contains `/.claude/worktrees/`, we can derive the main
    // project root and look for the transcript there.
    const effectiveCwd = cwd || process.cwd();
    const worktreeMarker = '.claude/worktrees/';
    const markerIdx = effectiveCwd.indexOf(worktreeMarker);
    if (markerIdx !== -1) {
        // Adjust index to exclude the preceding path separator
        const mainProjectRoot = effectiveCwd.substring(0, markerIdx > 0 && effectiveCwd[markerIdx - 1] === sep ? markerIdx - 1 : markerIdx);
        // Extract session filename from the original path
        const lastSep = transcriptPath.lastIndexOf('/');
        const sessionFile = lastSep !== -1 ? transcriptPath.substring(lastSep + 1) : '';
        if (sessionFile) {
            // The projects directory is under the Claude config dir
            const projectsDir = join(getClaudeConfigDir(), 'projects');
            if (existsSync(projectsDir)) {
                // Encode the main project root the same way Claude Code does:
                // replace path separators with `-`, replace dots with `-`.
                const encodedMain = mainProjectRoot.replace(/[/\\.]/g, '-');
                const resolvedPath = join(projectsDir, encodedMain, sessionFile);
                if (existsSync(resolvedPath))
                    return resolvedPath;
            }
        }
    }
    // Strategy 3: Detect native git worktree via git-common-dir.
    // When CWD is a linked worktree (created by `git worktree add`), the
    // transcript path encodes the worktree CWD, but the file lives under
    // the main repo's encoded path. Use `git rev-parse --git-common-dir`
    // to find the main repo root and re-encode.
    try {
        const gitCommonDir = execSync('git rev-parse --git-common-dir', {
            cwd: effectiveCwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const absoluteCommonDir = resolve(effectiveCwd, gitCommonDir);
        // For linked worktrees, git-common-dir is <repo>/.git/worktrees/<name>
        // so dirname gives <repo>/.git/worktrees — navigate up to the actual repo root
        let mainRepoRoot = dirname(absoluteCommonDir);
        if (mainRepoRoot.endsWith(join('.git', 'worktrees'))) {
            mainRepoRoot = dirname(dirname(mainRepoRoot));
        }
        // Resolve symlinks for consistent comparison (e.g. /tmp -> /private/tmp on macOS,
        // ecryptfs $HOME on Linux, autofs /home, etc.)
        try {
            mainRepoRoot = realpathSync(mainRepoRoot);
        }
        catch { /* keep as-is */ }
        const worktreeTop = execSync('git rev-parse --show-toplevel', {
            cwd: effectiveCwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (mainRepoRoot !== worktreeTop) {
            const lastSep = transcriptPath.lastIndexOf('/');
            const sessionFile = lastSep !== -1 ? transcriptPath.substring(lastSep + 1) : '';
            if (sessionFile) {
                const projectsDir = join(getClaudeConfigDir(), 'projects');
                if (existsSync(projectsDir)) {
                    const encodedMain = mainRepoRoot.replace(/[/\\.]/g, '-');
                    const resolvedPath = join(projectsDir, encodedMain, sessionFile);
                    if (existsSync(resolvedPath))
                        return resolvedPath;
                }
            }
        }
    }
    catch {
        // Not in a git repo or git not available — skip
    }
    // No resolution found — return original path.
    // Callers should handle non-existent paths gracefully.
    return transcriptPath;
}
/**
 * Validate that a workingDirectory is within the trusted worktree root.
 * The trusted root is derived from process.cwd(), NOT from user input.
 *
 * Always returns a git worktree root — never a subdirectory.
 * This prevents .claude-statusline/state/ from being created in subdirectories (#576).
 *
 * @param workingDirectory - User-supplied working directory
 * @returns The validated worktree root
 * @throws Error if workingDirectory is outside trusted root
 */
export function validateWorkingDirectory(workingDirectory) {
    const trustedRoot = getWorktreeRoot(process.cwd()) || process.cwd();
    if (!workingDirectory) {
        return trustedRoot;
    }
    // Resolve to absolute
    const resolved = resolve(workingDirectory);
    let trustedRootReal;
    try {
        trustedRootReal = realpathSync(trustedRoot);
    }
    catch {
        trustedRootReal = trustedRoot;
    }
    // Try to resolve the provided directory to a git worktree root.
    const providedRoot = getWorktreeRoot(resolved);
    if (providedRoot) {
        // Git resolution succeeded — require exact worktree identity.
        let providedRootReal;
        try {
            providedRootReal = realpathSync(providedRoot);
        }
        catch {
            throw new Error(`workingDirectory '${workingDirectory}' does not exist or is not accessible.`);
        }
        if (providedRootReal !== trustedRootReal) {
            console.error('[worktree] workingDirectory resolved to different git worktree root, using trusted root', {
                workingDirectory: resolved,
                providedRoot: providedRootReal,
                trustedRoot: trustedRootReal,
            });
            return trustedRoot;
        }
        return providedRoot;
    }
    // Git resolution failed (lock contention, env issues, non-repo dir).
    // Validate that the raw directory is under the trusted root before falling
    // back — otherwise reject it as truly outside (#576).
    let resolvedReal;
    try {
        resolvedReal = realpathSync(resolved);
    }
    catch {
        throw new Error(`workingDirectory '${workingDirectory}' does not exist or is not accessible.`);
    }
    const rel = relative(trustedRootReal, resolvedReal);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`workingDirectory '${workingDirectory}' is outside the trusted worktree root '${trustedRoot}'.`);
    }
    // Directory is under trusted root but git failed — return trusted root,
    // never the subdirectory, to prevent .claude-statusline/ creation in subdirs (#576).
    return trustedRoot;
}
