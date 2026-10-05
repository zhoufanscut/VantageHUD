/**
 * HUD - Git Elements
 *
 * Renders git repository name and branch information.
 */
import { realpathSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { runGit as git } from '../../lib/git-exec.js';
import { paint, paintLabel, paintWarn, PALETTE } from '../colors.js';
import { DEFAULT_HUD_LABELS } from '../types.js';
import { cleanText } from '../sanitize.js';
// No in-process caches: the HUD runs one process per render and each getter
// below is called at most once per render, so a Map could never hit.
/**
 * Get git repository name from remote URL.
 * Extracts the repo name from URLs like:
 * - https://github.com/user/repo.git
 * - git@github.com:user/repo.git
 *
 * @param cwd - Working directory to run git command in
 * @returns Repository name or null if not available
 */
export function getGitRepoName(cwd) {
    let result = null;
    try {
        const url = git(['remote', 'get-url', 'origin'], cwd);
        if (!url) {
            result = null;
        }
        else {
            // Extract repo name from URL
            // Handles: https://github.com/user/repo.git, git@github.com:user/repo.git
            // A trailing slash (`.../proj/`, `.../proj.git/`) is valid for git
            // and would otherwise defeat both patterns.
            const trimmed = url.replace(/\/+$/, '');
            const match = trimmed.match(/\/([^/]+?)(?:\.git)?$/) || trimmed.match(/:([^/]+?)(?:\.git)?$/);
            result = match ? match[1].replace(/\.git$/, '') : null;
        }
    }
    catch {
        result = null;
    }
    return result;
}
/**
 * Get current git branch name.
 *
 * @param cwd - Working directory to run git command in
 * @returns Branch name or null if not available
 */
export function getGitBranch(cwd) {
    try {
        // `symbolic-ref`, not `branch --show-current` (git >= 2.22): it works
        // on any git, prints an unborn branch's name too, and exits non-zero
        // on a detached HEAD, which lands in the catch as "no branch".
        return git(['symbolic-ref', '--short', '-q', 'HEAD'], cwd) || null;
    }
    catch {
        return null;
    }
}
/**
 * Detect if the current directory is inside a git linked worktree.
 * Compares --git-dir with --git-common-dir; they differ in linked worktrees.
 * When in a worktree, extracts the worktree name from the git-dir path.
 *
 * @param cwd - Working directory
 * @returns Worktree detection result
 */
export function getWorktreeInfo(cwd) {
    const key = cwd ? resolve(cwd) : process.cwd();
    let result = { isWorktree: false, worktreeName: null };
    try {
        const [gitDir, gitCommonDir] = git(['rev-parse', '--git-dir', '--git-common-dir'], cwd).split(/\r?\n/);
        // Canonicalize via realpathSync to handle symlinked repo paths
        let resolvedGitDir = resolve(key, gitDir);
        let resolvedCommonDir = resolve(key, gitCommonDir);
        try {
            resolvedGitDir = realpathSync(resolvedGitDir);
        }
        catch { /* use resolved */ }
        try {
            resolvedCommonDir = realpathSync(resolvedCommonDir);
        }
        catch { /* use resolved */ }
        if (resolvedGitDir !== resolvedCommonDir) {
            // Extract worktree name from gitDir path (e.g. /repo/.git/worktrees/my-wt → my-wt)
            result = { isWorktree: true, worktreeName: basename(resolvedGitDir) };
        }
    }
    catch {
        // Not in a git repo or command failed
    }
    return result;
}
/**
 * Render git repository name element.
 *
 * @param cwd - Working directory
 * @param knownName - Repo name Claude Code already parsed from `origin`
 *   (the payload's `workspace.repo.name`); spares the `git remote get-url`
 *   spawn when given
 * @returns Formatted repo name or null
 */
export function renderGitRepo(cwd, knownName = null) {
    const repo = knownName || getGitRepoName(cwd);
    if (!repo)
        return null;
    return `${paintLabel('repo:')}${paint(PALETTE.gradLow, cleanText(repo))}`;
}
/**
 * Render git branch element.
 * When inside a linked worktree, appends the worktree name as suffix:
 *   branch:feature-x (wt:my-wt)
 *
 * @param cwd - Working directory
 * @param worktreeHint - `{ known, name }` derived from the payload's
 *   `workspace.git_worktree`: when `known`, `name` is the linked-worktree name
 *   (or null for the main working tree) and the two `git rev-parse` spawns are
 *   skipped; otherwise git is asked
 * @returns Formatted branch name or null
 */
export function renderGitBranch(cwd, worktreeHint = null) {
    const branch = getGitBranch(cwd);
    if (!branch)
        return null;
    const wtInfo = worktreeHint && worktreeHint.known
        ? { isWorktree: Boolean(worktreeHint.name), worktreeName: worktreeHint.name }
        : getWorktreeInfo(cwd);
    if (wtInfo.isWorktree && wtInfo.worktreeName) {
        return `${paintLabel('branch:')}${paint(PALETTE.gradLow, cleanText(branch))} ${paintLabel('(wt:')}${paint(PALETTE.gradLow, cleanText(wtInfo.worktreeName))}${paintLabel(')')}`;
    }
    return `${paintLabel('branch:')}${paint(PALETTE.gradLow, cleanText(branch))}`;
}
/**
 * Test a porcelain-v1 status pair for an unmerged (conflicted) path.
 *
 * The seven unmerged pairs are DD, AU, UD, UA, DU, AA, UU: a `U` on either
 * side, plus the AA/DD doubles. Git puts them in the index column, so the plain
 * `idx !== ' '` test that follows would score a conflicted tree as cleanly
 * staged — mid-merge the HUD then read `+3` as if nothing were wrong.
 */
function isUnmergedStatus(idx, wt) {
    if (idx === 'U' || wt === 'U') {
        return true;
    }
    return (idx === 'A' && wt === 'A') || (idx === 'D' && wt === 'D');
}
/**
 * Get git working tree status counts.
 * Parses `git status --porcelain -b` (optional locks off, see git-exec.js) for staged, modified, untracked,
 * conflicted, ahead, and behind counts.
 *
 * @param cwd - Working directory
 * @returns Status counts or null if not in a git repo
 */
export function getGitStatusCounts(cwd) {
    let result = null;
    try {
        const output = git(['status', '--porcelain', '-b'], cwd);
        let staged = 0, modified = 0, untracked = 0, conflicted = 0, ahead = 0, behind = 0;
        if (output) {
            const lines = output.split('\n');
            // Parse branch line for ahead/behind: ## main...origin/main [ahead 3, behind 1]
            const branchLine = lines[0];
            const aheadMatch = branchLine.match(/\bahead (\d+)/);
            const behindMatch = branchLine.match(/\bbehind (\d+)/);
            if (aheadMatch)
                ahead = parseInt(aheadMatch[1], 10);
            if (behindMatch)
                behind = parseInt(behindMatch[1], 10);
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                if (!line || line.length < 2)
                    continue;
                const idx = line[0];
                const wt = line[1];
                if (idx === '?') {
                    untracked++;
                }
                else if (isUnmergedStatus(idx, wt)) {
                    conflicted++;
                }
                else {
                    if (idx !== ' ' && idx !== '?')
                        staged++;
                    // Any worktree change counts, not only M/D: a typechange
                    // (` T`, a file replaced by a symlink) and an intent-to-add
                    // (` A`, `git add -N`) read as a clean tree otherwise. `?`
                    // and the unmerged pairs were taken above, and `!` needs
                    // --ignored, which is never passed.
                    if (wt !== ' ')
                        modified++;
                }
            }
        }
        result = { staged, modified, untracked, conflicted, ahead, behind };
    }
    catch {
        result = null;
    }
    return result;
}
/**
 * Render git working tree status element.
 * Format: ✗1 +2 !3 ?1 ⇡1 ⇣2
 *
 * Conflicts lead the fragment, in the critical tone, because an unmerged tree
 * is the one state here you must clear before anything else lands.
 *
 * @param cwd - Working directory
 * @returns Formatted status or null if clean or not in a git repo
 */
export function renderGitStatus(cwd, labels = DEFAULT_HUD_LABELS) {
    const counts = getGitStatusCounts(cwd);
    if (!counts)
        return null;
    const { staged, modified, untracked, conflicted = 0, ahead, behind } = counts;
    if (staged === 0 && modified === 0 && untracked === 0 && conflicted === 0 && ahead === 0 && behind === 0) {
        return null;
    }
    const parts = [];
    if (conflicted > 0)
        parts.push(paintWarn(`${labels.conflict}${conflicted}`, true));
    if (staged > 0)
        parts.push(paint(PALETTE.add, `${labels.staged}${staged}`));
    if (modified > 0)
        parts.push(paint(PALETTE.del, `${labels.modified}${modified}`));
    if (untracked > 0)
        parts.push(paint(PALETTE.track, `${labels.untracked}${untracked}`));
    if (ahead > 0)
        parts.push(paint(PALETTE.add, `${labels.ahead}${ahead}`));
    if (behind > 0)
        parts.push(paint(PALETTE.del, `${labels.behind}${behind}`));
    return parts.join(' ');
}
