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
import { existsSync, readdirSync, realpathSync, statSync } from 'fs';
import { resolve, sep, join, dirname } from 'path';
import { getClaudeConfigDir } from './config-dir.js';
import { getHudInstallRoot } from './install-paths.js';
import { runGit } from './git-exec.js';
/**
 * `git rev-parse --show-toplevel` results for this process, misses included.
 * One process renders one frame, so a directory cannot become a repository
 * between two lookups, and the same answer is asked for up to three times per
 * frame (resolveToWorktreeRoot, resolveTranscriptPath, render.js's VCS choice).
 * A root found is also stored under the root itself, because render.js asks
 * again with the resolved root rather than the session's own cwd.
 */
const worktreeRootCache = new Map();
/**
 * Get the git worktree root for the current or specified directory.
 * Returns null if not in a git repository.
 */
export function getWorktreeRoot(cwd) {
    const effectiveCwd = cwd || process.cwd();
    if (worktreeRootCache.has(effectiveCwd)) {
        return worktreeRootCache.get(effectiveCwd);
    }
    let root = null;
    try {
        root = runGit(['rev-parse', '--show-toplevel'], effectiveCwd, 5000) || null;
    }
    catch {
        // Not in a git repository, or git is missing/too slow.
    }
    worktreeRootCache.set(effectiveCwd, root);
    if (root) {
        worktreeRootCache.set(root, root);
    }
    return root;
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
 * Resolve a session-scoped cache file path: `<cacheDir>/<session>/<baseName>.json`.
 *
 * Each session gets its own subfolder (named by the sanitized session id), so a
 * session's files are grouped together and unrelated sessions — or projects
 * sharing one install — never collide.
 */
export function sessionCacheFile(baseName, sessionKey) {
    return join(getSessionCacheDir(sessionKey), `${baseName}.json`);
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
 * Under 1.7+ the nearest `.svn` holding `wc.db` is the root, and the climb
 * stops there. That `.svn` exists only at a working-copy root, and also at the
 * root of each external and of a checkout nested in another, so climbing on
 * past it reported the *outer* project for a cwd inside an external (`wc/lib`
 * from `^/lib/trunk lib`). Pre-1.7 checkouts have no `wc.db` and put a `.svn`
 * in every directory, so for them the walk returns the *topmost* contiguous
 * ancestor holding one (the nearest is merely the subdirectory you happen to
 * be standing in).
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
            let hasWcDb = false;
            try {
                hasWcDb = statSync(join(dir, '.svn', 'wc.db')).isFile();
            }
            catch {
                // Pre-1.7 layout: keep climbing the contiguous run.
            }
            if (hasWcDb) {
                break;
            }
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
 * Spell a canonical VCS root the way the session's own cwd spells it.
 *
 * Both roots come back canonical — git's `--show-toplevel` always, and
 * findSvnWorkingCopyRoot realpaths first — so a session started in a symlink
 * (`~/work/link` → `/data/proj`) showed `/data/proj`, and lost the `~` when
 * the target was outside $HOME, while a plain symlinked directory kept the
 * link path. The root is mapped back only when that is exact: the cwd *is* the
 * root, or the cwd's path below the root is also the tail of the given path.
 * A link pointing *into* the tree (`link` → `repo/a/b`) has no such spelling,
 * and a lexical `link/../..` would name the wrong directory, so it keeps the
 * canonical root.
 *
 * @param given - The cwd as given (resolved, not canonicalized)
 * @param root - The canonical root containing it
 * @returns The root under the given spelling, or `root` itself
 */
function onGivenPath(given, root) {
    let real;
    try {
        real = realpathSync(given);
    }
    catch {
        return root;
    }
    if (real === root) {
        return given;
    }
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (real.indexOf(prefix) !== 0) {
        // Includes Windows, where git prints `C:/x` and realpath `C:\x`.
        return root;
    }
    const below = real.slice(prefix.length);
    const tail = `${sep}${below}`;
    return given.endsWith(tail) && given.length > tail.length
        ? given.slice(0, given.length - tail.length)
        : root;
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
 * @returns The repository/working-copy root (never a subdirectory; spelled as
 *   the given path spells it when that is exact, see onGivenPath), else the
 *   directory itself
 */
export function resolveToWorktreeRoot(directory) {
    if (directory) {
        const resolved = resolve(directory);
        const root = getWorktreeRoot(resolved);
        if (root) {
            const shown = onGivenPath(resolved, root);
            // render.js asks getWorktreeRoot again with what this returns.
            worktreeRootCache.set(shown, root);
            return shown;
        }
        const svnRoot = findSvnWorkingCopyRoot(resolved);
        if (svnRoot)
            return onGivenPath(resolved, svnRoot);
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
/** Claude Code's cap on an encoded project-dir name before it adds a hash. */
const MAX_PROJECT_DIR_NAME = 200;
/**
 * Find `<config>/projects/<encoded projectRoot>/<sessionFile>`.
 *
 * The encoding mirrors Claude Code's (2.1.289): every character outside
 * `[a-zA-Z0-9]` becomes `-`, so `_`, spaces and a Windows drive's `:` do too —
 * not just `/`, `\` and `.`, which is all this used to replace. A name longer
 * than 200 characters is cut there and given a `-<hash>` suffix of the full
 * path; that hash cannot be recomputed here, so such a directory is found by
 * its prefix instead.
 *
 * @returns The transcript path, or null when it is not there
 */
function findProjectTranscript(projectRoot, sessionFile) {
    const projectsDir = join(getClaudeConfigDir(), 'projects');
    const encoded = projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
    if (encoded.length <= MAX_PROJECT_DIR_NAME) {
        const candidate = join(projectsDir, encoded, sessionFile);
        return existsSync(candidate) ? candidate : null;
    }
    const prefix = `${encoded.slice(0, MAX_PROJECT_DIR_NAME)}-`;
    try {
        for (const name of readdirSync(projectsDir)) {
            if (name.indexOf(prefix) === 0) {
                const candidate = join(projectsDir, name, sessionFile);
                if (existsSync(candidate))
                    return candidate;
            }
        }
    }
    catch {
        // No projects directory, or unreadable.
    }
    return null;
}
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
 * Claude Code encodes every non-alphanumeric character as `-` (see
 * findProjectTranscript). The `.claude/worktrees/`
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
            const resolvedPath = findProjectTranscript(mainProjectRoot, sessionFile);
            if (resolvedPath)
                return resolvedPath;
        }
    }
    // Strategy 3: Detect native git worktree via git-common-dir.
    // When CWD is a linked worktree (created by `git worktree add`), the
    // transcript path encodes the worktree CWD, but the file lives under
    // the main repo's encoded path. In a linked worktree `--git-dir` is
    // `<repo>/.git/worktrees/<name>` while `--git-common-dir` is `<repo>/.git`,
    // so the two differ and the common dir's parent is the main repo root;
    // anywhere else they are the same directory and there is nothing to do.
    // getWorktreeRoot is cached, so outside git this costs no spawn at all.
    if (getWorktreeRoot(effectiveCwd) !== null) {
        try {
            const [gitDir, gitCommonDir] = runGit(['rev-parse', '--git-dir', '--git-common-dir'], effectiveCwd)
                .split(/\r?\n/);
            const absoluteGitDir = resolve(effectiveCwd, gitDir);
            const absoluteCommonDir = resolve(effectiveCwd, gitCommonDir);
            if (absoluteGitDir !== absoluteCommonDir) {
                let mainRepoRoot = dirname(absoluteCommonDir);
                // Resolve symlinks for consistent comparison (e.g. /tmp -> /private/tmp on macOS,
                // ecryptfs $HOME on Linux, autofs /home, etc.)
                try {
                    mainRepoRoot = realpathSync(mainRepoRoot);
                }
                catch { /* keep as-is */ }
                const lastSep = transcriptPath.lastIndexOf('/');
                const sessionFile = lastSep !== -1 ? transcriptPath.substring(lastSep + 1) : '';
                if (sessionFile) {
                    const resolvedPath = findProjectTranscript(mainRepoRoot, sessionFile);
                    if (resolvedPath)
                        return resolvedPath;
                }
            }
        }
        catch {
            // git failed or timed out — skip
        }
    }
    // No resolution found — return original path.
    // Callers should handle non-existent paths gracefully.
    return transcriptPath;
}
