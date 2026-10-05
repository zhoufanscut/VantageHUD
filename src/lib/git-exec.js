/**
 * Run one git command — the single spawn path for every git call the HUD makes
 * (worktree-paths.js and elements/git.js), so all of them share one set of
 * options.
 *
 * - `execFileSync`, not `execSync`: no `/bin/sh` (or `cmd.exe`) in front of
 *   each call, and no shell parsing of the arguments.
 * - `GIT_OPTIONAL_LOCKS=0` instead of the `--no-optional-locks` flag: the same
 *   effect on git >= 2.15 (status skips refreshing the index, so it never
 *   contends with the user's own git), and an older git ignores an unknown
 *   variable where it rejects an unknown flag.
 * - `maxBuffer` is raised above execFileSync's 1 MiB default because overflow
 *   throws (ENOBUFS) rather than truncating: `git status --porcelain` spends
 *   ~70 bytes per untracked path, so a large unignored tree (measured: 16,000
 *   files → 1.2 MB) silently deleted the status fragment. Same fix as svn.js.
 *
 * An inherited `GIT_DIR` / `GIT_WORK_TREE` is passed through on purpose: Claude
 * Code's own git commands follow it too, so the HUD describes the repository
 * the session's git sees, not necessarily the one under `cwd`.
 */
import { execFileSync } from 'node:child_process';
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
/**
 * @param args - git arguments
 * @param cwd - Directory to run in
 * @param timeout - Kill the command after this many ms (it then throws)
 * @returns Trimmed stdout; throws on a non-zero exit, a timeout or no git
 */
export function runGit(args, cwd, timeout = 1000) {
    return execFileSync('git', args, {
        cwd,
        env: GIT_ENV,
        encoding: 'utf-8',
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    }).trim();
}
