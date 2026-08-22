/**
 * Worktree + cache path helpers.
 *
 * Worktree resolution (getWorktreeRoot / resolveToWorktreeRoot /
 * resolveTranscriptPath) is used for cwd display and transcript lookup.
 *
 * Runtime files live in a per-session subfolder of the cache directory
 * (getCacheDir → HUD_CACHE_DIR || <install>/cache), i.e.
 * `<cacheDir>/<session>/<name>.json`. Nothing is ever written inside a user's
 * project, and the globally-unique session id names the folder, so unrelated
 * sessions (and projects sharing one install) never collide.
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, realpathSync, readdirSync, statSync } from 'fs';
import { resolve, relative, sep, join, isAbsolute, dirname } from 'path';
import { getClaudeConfigDir } from './config-dir.js';
import { getHudInstallRoot } from './install-paths.js';
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
// SESSION CACHE PATHS (<cacheDir>/<session>/<name>.json) — matches statusline.sh
// ============================================================================
/**
 * Resolve the shared cache root. Both the shell wrapper's render cache and the
 * Node HUD's state live under here, each in a per-session subfolder
 * (`<cacheDir>/<session>/<base>.json`).
 *
 * The default is the HUD install's own `cache/` folder, derived from the
 * install root (`getHudInstallRoot`) so it follows a relocated install — the
 * same `$SCRIPT_DIR/cache` statusline.sh resolves. `HUD_CACHE_DIR` overrides it
 * (honored by the shell too), so the two layers never diverge.
 */
export function getCacheDir() {
    if (process.env.HUD_CACHE_DIR) {
        return process.env.HUD_CACHE_DIR;
    }
    return join(getHudInstallRoot(), 'cache');
}
/**
 * Sanitize a session key for use as a cache folder name. Mirrors the shell's
 * `sed 's/[^A-Za-z0-9_.-]/_/g'` (statusline.sh) so Node and the shell agree on
 * the folder for the same session. Empty/missing keys — and a bare `.`/`..`,
 * which would otherwise point the session dir at the cache root or its parent —
 * collapse to `default`.
 */
export function sanitizeSessionKey(sessionKey) {
    const raw = (sessionKey == null ? '' : String(sessionKey)).trim();
    if (!raw) {
        return 'default';
    }
    const safe = raw.replace(/[^A-Za-z0-9_.-]/g, '_');
    return safe === '.' || safe === '..' ? 'default' : safe;
}
/**
 * Resolve a session's cache subfolder: `<cacheDir>/<session>`.
 *
 * The sanitized session id names the folder, so every file for one session is
 * grouped together and unrelated sessions (or projects sharing one install)
 * never collide.
 */
export function getSessionCacheDir(sessionKey) {
    return join(getCacheDir(), sanitizeSessionKey(sessionKey));
}
/**
 * Ensure a session's cache subfolder exists. Best-effort; tolerates the EEXIST
 * race between concurrent sessions (see atomic-write.js:ensureDirSync). Callers
 * using raw fs.writeFileSync must call this first — only atomicWriteFileSync and
 * the file lock auto-create parent dirs.
 */
export function ensureSessionCacheDir(sessionKey) {
    const dir = getSessionCacheDir(sessionKey);
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
 * Resolve a session-scoped cache file path: `<cacheDir>/<session>/<baseName>.json`.
 *
 * Each session gets its own subfolder (named by the sanitized session id), so a
 * session's files are grouped together and unrelated sessions — or projects
 * sharing one install — never collide.
 */
export function sessionCacheFile(baseName, sessionKey) {
    return join(getSessionCacheDir(sessionKey), `${baseName}.json`);
}
/**
 * List existing `<session>/<baseName>.json` cache files across every session
 * subfolder, most-recently-modified first (absolute paths). Used only as a
 * fallback for readers that have no session key (e.g. a detached watch
 * process); the primary path always passes a key.
 */
export function listSessionCacheFiles(baseName) {
    const dir = getCacheDir();
    if (!existsSync(dir)) {
        return [];
    }
    const fileName = `${baseName}.json`;
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(dir, entry.name, fileName))
            .filter((path) => existsSync(path))
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
/** Upward `.svn` search bound — a stop for pathological paths, never reached in practice. */
const MAX_SVN_WALK_DEPTH = 64;
/**
 * Find the root of the Subversion working copy containing `directory`.
 *
 * Pure filesystem, deliberately: this runs on every render for any directory
 * git disowned, and it is the gate in front of every `svn` subprocess — a
 * non-SVN directory must not pay for SVN support.
 *
 * Returns the *topmost* contiguous ancestor holding a `.svn`, which is the
 * working-copy root under both on-disk layouts: 1.7+ keeps a single `.svn` at
 * the root, while pre-1.7 checkouts put one in every directory (there the
 * nearest `.svn` is merely the subdirectory you happen to be standing in).
 *
 * @param directory - Any directory inside (or above) a working copy
 * @returns The working-copy root, or null when there is no `.svn` above it
 */
export function findSvnWorkingCopyRoot(directory) {
    let dir = directory ? resolve(directory) : process.cwd();
    // `resolve` does not follow symlinks, so without this the climb walks the
    // *link's* parents: a cwd symlinked into a 1.7+ working copy (only the root
    // holds `.svn`) would find nothing and the VCS fragments would vanish.
    // git.js canonicalizes for the same reason.
    try {
        dir = realpathSync(dir);
    }
    catch {
        // Unreadable or missing — walk the resolved path as-is.
    }
    let root = null;
    for (let depth = 0; depth < MAX_SVN_WALK_DEPTH; depth += 1) {
        let hasSvnDir = false;
        try {
            hasSvnDir = statSync(join(dir, '.svn')).isDirectory();
        }
        catch {
            // No `.svn` here, or the path is unreadable.
        }
        if (hasSvnDir) {
            root = dir;
        }
        else if (root) {
            // The contiguous run of `.svn` ancestors ended — `root` is the top.
            break;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return root;
}
/**
 * Resolve a directory path to its version-control root.
 *
 * Walks up from `directory` using `git rev-parse --show-toplevel`, then falls
 * back to the Subversion working-copy root, then to the directory as given.
 * Only a *missing* `directory` falls back to the process cwd — a session's own
 * cwd is better information than the process's, and substituting the latter
 * made a session in any non-git directory report the HUD install's repo.
 *
 * Used to derive the cwd shown in the HUD and to resolve transcript paths —
 * not for state location (runtime files live under getCacheDir()/<session>/).
 *
 * @param directory - Any directory inside a git worktree or SVN checkout (optional)
 * @returns The repository/working-copy root (never a subdirectory), else the directory itself
 */
export function resolveToWorktreeRoot(directory) {
    if (directory) {
        const resolved = resolve(directory);
        const root = getWorktreeRoot(resolved);
        if (root)
            return root;
        const svnRoot = findSvnWorkingCopyRoot(resolved);
        if (svnRoot)
            return svnRoot;
        if (process.env.HUD_DEBUG) {
            console.error('[worktree] neither a git worktree nor an svn checkout, using it as given', {
                directory: resolved,
            });
        }
        return resolved;
    }
    // No directory given (e.g. a detached reader): derive from the process CWD.
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
