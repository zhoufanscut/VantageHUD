/**
 * Worktree Path Enforcement
 *
 * Provides strict path validation and resolution for .claude-statusline/ paths,
 * ensuring all operations stay within the worktree boundary.
 *
 * State is centralized under <hud-install>/.claude-statusline/{project-identifier}/
 * by default, so no .claude-statusline/ folder is ever created inside a user's
 * project. The HUD_STATE_DIR environment variable overrides the base directory.
 */
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, realpathSync, readdirSync } from 'fs';
import { resolve, normalize, relative, sep, join, isAbsolute, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getClaudeConfigDir } from './config-dir.js';
/** Standard .claude-statusline subdirectories */
export const StatePaths = {
    ROOT: '.claude-statusline',
};
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
// STATE PATH RESOLUTION (default base = HUD install dir; HUD_STATE_DIR overrides) — Issue #1014
// ============================================================================
/**
 * Get a stable project identifier for centralized state storage.
 *
 * Uses a hybrid strategy:
 * 1. Git remote URL hash (stable across worktrees and clones of the same repo)
 * 2. Fallback to worktree root path hash (for local-only repos without remotes)
 *
 * Format: `{dirName}-{hash}` where hash is first 16 chars of SHA-256.
 * Example: `my-project-a1b2c3d4e5f6g7h8`
 *
 * @param worktreeRoot - Optional worktree root path
 * @returns A stable project identifier string
 */
export function getProjectIdentifier(worktreeRoot) {
    const root = worktreeRoot || getWorktreeRoot() || process.cwd();
    let source;
    try {
        const remoteUrl = execSync('git remote get-url origin', {
            cwd: root,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        source = remoteUrl || root;
    }
    catch {
        // No git remote (local-only repo or not a git repo) — use path
        source = root;
    }
    // For linked worktrees (created via `git worktree add`), resolve to the
    // primary repository root so all worktrees of the same repo produce the
    // same project identifier. Without this, sibling worktrees like
    // `repo.feature-x/` and `repo.feature-y/` would create separate state
    // directories despite sharing the same remote URL hash.
    let primaryRoot = root;
    try {
        const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
            cwd: root,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000,
        }).trim();
        // Only resolve when --git-common-dir points to a .git directory.
        // - Linked worktrees: returns <primary>/.git → dirname gives primary root ✓
        // - Submodules: returns <super>/.git/modules/<name> → skip (wrong parent)
        // - Bare repos: returns the repo root itself (no .git suffix) → skip
        //   (dirname would go up to the parent folder, colliding sibling repos)
        const isGitDir = basename(commonDir) === '.git';
        const isSubmodule = commonDir.includes(`${sep}.git${sep}modules`);
        if (isGitDir && !isSubmodule) {
            const resolved = dirname(commonDir);
            if (resolved && resolved !== root) {
                primaryRoot = resolved;
            }
        }
    }
    catch {
        // Not a git repo or command failed — fall back to worktree root
    }
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
    const dirName = basename(primaryRoot).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${dirName}-${hash}`;
}
/**
 * Default state base directory: the HUD install's own `.claude-statusline/`
 * folder, derived from this module's location so it stays correct if the HUD
 * is relocated. worktree-paths.js lives at `<hud-install>/src/lib/`, so the
 * install root is two directories up.
 */
function getDefaultStateBase() {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const hudInstallRoot = resolve(moduleDir, '..', '..');
    return join(hudInstallRoot, StatePaths.ROOT);
}
/**
 * Get the state root directory for a project.
 *
 * State is centralized under a single base directory with a per-project
 * subdirectory, so unrelated projects never collide:
 *   <base>/<project-identifier>/
 *
 * The base defaults to the HUD install's own `.claude-statusline/` folder
 * (next to the code), so a `.claude-statusline/` directory is never created
 * inside a user's project. Setting HUD_STATE_DIR overrides the base.
 *
 * @param worktreeRoot - Optional worktree root (used to derive the project id)
 * @returns Absolute path to the project's state root
 */
export function getStateRoot(worktreeRoot) {
    const root = worktreeRoot || getWorktreeRoot() || process.cwd();
    const baseDir = process.env.HUD_STATE_DIR || getDefaultStateBase();
    return join(baseDir, getProjectIdentifier(root));
}
/**
 * Resolve a relative path under .claude-statusline/ to an absolute path.
 * Validates the path is within the hud boundary.
 *
 * @param relativePath - Path relative to .claude-statusline/ (e.g., "state/session.json")
 * @param worktreeRoot - Optional worktree root (auto-detected if not provided)
 * @returns Absolute path
 * @throws Error if path would escape hud boundary
 */
export function resolveStatePath(relativePath, worktreeRoot) {
    validatePath(relativePath);
    const stateDir = getStateRoot(worktreeRoot);
    const fullPath = normalize(resolve(stateDir, relativePath));
    // Verify resolved path is still under hud directory
    const relativeToState = relative(stateDir, fullPath);
    if (relativeToState.startsWith('..') || relativeToState.startsWith(sep + '..')) {
        throw new Error(`Path escapes hud boundary: ${relativePath}`);
    }
    return fullPath;
}
// ============================================================================
// SESSION-SCOPED STATE PATHS
// ============================================================================
/** Regex for valid session IDs: alphanumeric, hyphens, underscores, max 256 chars */
const SESSION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
/**
 * Validate a session ID to prevent path traversal attacks.
 *
 * @param sessionId - The session ID to validate
 * @throws Error if session ID is invalid
 */
export function validateSessionId(sessionId) {
    if (!sessionId) {
        throw new Error('Session ID cannot be empty');
    }
    if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
        throw new Error(`Invalid session ID: path traversal not allowed (${sessionId})`);
    }
    if (!SESSION_ID_REGEX.test(sessionId)) {
        throw new Error(`Invalid session ID: must be alphanumeric with hyphens/underscores, max 256 chars (${sessionId})`);
    }
}
/**
 * Resolve a session-scoped state file path.
 * Path: {stateRoot}/state/sessions/{sessionId}/{mode}-state.json
 *
 * @param stateName - State name (e.g., "session", "mode")
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to session-scoped state file
 */
export function resolveSessionStatePath(stateName, sessionId, worktreeRoot) {
    validateSessionId(sessionId);
    const normalizedName = stateName.endsWith('-state') ? stateName : `${stateName}-state`;
    return resolveStatePath(`state/sessions/${sessionId}/${normalizedName}.json`, worktreeRoot);
}
/**
 * Get the session state directory path.
 * Path: {stateRoot}/state/sessions/{sessionId}/
 *
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to session state directory
 */
export function getSessionStateDir(sessionId, worktreeRoot) {
    validateSessionId(sessionId);
    return join(getStateRoot(worktreeRoot), 'state', 'sessions', sessionId);
}
/**
 * List all session IDs that have state directories.
 *
 * @param worktreeRoot - Optional worktree root
 * @returns Array of session IDs
 */
export function listSessionIds(worktreeRoot) {
    const sessionsDir = join(getStateRoot(worktreeRoot), 'state', 'sessions');
    if (!existsSync(sessionsDir)) {
        return [];
    }
    try {
        const entries = readdirSync(sessionsDir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isDirectory() && SESSION_ID_REGEX.test(entry.name))
            .map(entry => entry.name);
    }
    catch {
        return [];
    }
}
/**
 * Ensure the session state directory exists.
 *
 * @param sessionId - Session identifier
 * @param worktreeRoot - Optional worktree root
 * @returns Absolute path to the session state directory
 */
export function ensureSessionStateDir(sessionId, worktreeRoot) {
    const sessionDir = getSessionStateDir(sessionId, worktreeRoot);
    if (!existsSync(sessionDir)) {
        try {
            mkdirSync(sessionDir, { recursive: true });
        }
        catch (err) {
            // On Windows, concurrent hooks can race past the existsSync check and
            // throw EEXIST. Safe to ignore — see atomic-write.ts:ensureDirSync.
            if (err.code !== "EEXIST")
                throw err;
        }
    }
    return sessionDir;
}
/**
 * Resolve a directory path to its git worktree root.
 *
 * Walks up from `directory` using `git rev-parse --show-toplevel`.
 * Falls back to `getWorktreeRoot(process.cwd())`, then `process.cwd()`.
 *
 * This ensures .claude-statusline/ state is always written at the worktree root,
 * even when called from a subdirectory (fixes #576).
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
