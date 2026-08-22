/**
 * HUD - Subversion Elements
 *
 * Renders repository name, branch, and working-copy status for Subversion
 * checkouts, mirroring the git elements so an SVN user sees the same shapes:
 * `repo:proj | branch:trunk@12345 | ✗1 +2 !3 ?1`.
 *
 * `render.js` reaches these only as a fallback — git is tried first, and the
 * probe here is a filesystem walk for a `.svn` directory, so a git checkout
 * never spawns `svn`.
 *
 * Both commands are read-only and **local**: `svn info` and a bare `svn status`
 * do not contact the server (that needs `-u`, which is why there is no
 * ahead/behind counterpart to git's `⇡`/`⇣`). `--non-interactive` guarantees
 * neither can block on a credentials prompt, and `--xml` keeps parsing free of
 * the locale-dependent text output.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { findSvnWorkingCopyRoot, sessionCacheFile } from '../../lib/worktree-paths.js';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import { paint, paintLabel, paintWarn, PALETTE } from '../colors.js';
import { DEFAULT_HUD_LABELS } from '../types.js';
/**
 * Intra-render de-duplication only — the HUD runs one process per render, so
 * these Maps never survive a frame. They exist because `renderSvnRepo` and
 * `renderSvnBranch` both want `svn info` in the same frame; anything that must
 * outlive the process goes to disk instead (see `readStatusMemo`).
 */
const CACHE_TTL_MS = 30_000;
const workingCopyCache = new Map();
const infoCache = new Map();
const statusCache = new Map();
/**
 * Run one `svn` command and return its stdout.
 *
 * `maxBuffer` is raised well above execFileSync's 1 MiB default because
 * overflow **throws** (ENOBUFS) rather than truncating: `svn status --xml`
 * spends ~90 bytes per unversioned path, so a build directory missing from
 * `svn:ignore` would silently delete the status element instead of reporting
 * it. `timeout` is per command — `info` reads one file, while `status` walks
 * the whole working copy and is memoized to disk by its caller.
 */
function svn(args, cwd, timeout) {
    return execFileSync('svn', args, {
        cwd,
        encoding: 'utf-8',
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
}
/** `svn info` reads a single file; a slow one is a broken one. */
const INFO_TIMEOUT_MS = 1000;
/** `svn status` walks the working copy — a large one legitimately takes seconds. */
const STATUS_TIMEOUT_MS = 3000;
/** How long a memoized status stays authoritative before a rescan. */
const STATUS_MEMO_TTL_MS = 30_000;
/**
 * Read the memoized status counts for `cwd`, at any age.
 *
 * The memo lives on disk (`cache/<session>/svn-status.json`) because the HUD
 * runs one process per render: the module-level Maps below de-duplicate calls
 * *within* a frame and are gone by the next one, so without this every frame
 * would re-walk the working copy. Same reason `subagents.js` memoizes its
 * tallies. Holds one entry — a session works in one directory — and a
 * different `cwd` simply reads as a miss.
 */
function readStatusMemo(sessionKey, cwdKey) {
    if (!sessionKey) {
        return null;
    }
    try {
        const memo = JSON.parse(readFileSync(sessionCacheFile('svn-status', sessionKey), 'utf-8'));
        if (memo?.cwd !== cwdKey || !memo.counts || typeof memo.at !== 'number') {
            return null;
        }
        return memo;
    }
    catch {
        // No memo yet, or it is unreadable/torn — treat as a cold start.
        return null;
    }
}
function writeStatusMemo(sessionKey, cwdKey, counts) {
    if (!sessionKey) {
        return;
    }
    try {
        atomicWriteJsonSync(sessionCacheFile('svn-status', sessionKey), {
            cwd: cwdKey,
            counts,
            at: Date.now(),
        });
    }
    catch {
        // Best-effort: a missed memo only costs the next frame a rescan.
    }
}
/**
 * Decode the predefined XML entities.
 *
 * Subversion's escaper (`libsvn_subr/xml_escape.c`) emits `&amp; &lt; &gt;` in
 * character data and adds `&quot; &apos;` inside attributes, plus *numeric*
 * references for control characters (`&#13;` and friends). Only the named ones
 * are decoded here: the values this module reads are URLs, which cannot carry a
 * raw control character — `svn` percent-encodes them — so a numeric reference
 * never reaches this function. `&amp;` is decoded last so `&amp;lt;` survives
 * as the literal text `&lt;`.
 */
function decodeXml(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}
/**
 * Percent-decode a repository URL for display, keeping the raw text when it is
 * not valid UTF-8 percent-encoding (decodeURIComponent throws on `%zz`).
 */
function decodeUrl(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
/**
 * Detect a Subversion working copy at or above `cwd`.
 *
 * Thin cached wrapper over `findSvnWorkingCopyRoot` (`src/lib/worktree-paths.js`),
 * which walks the filesystem rather than shelling out — this gates every `svn`
 * call, so a git (or plain) directory must not pay for SVN support.
 *
 * @param cwd - Working directory
 * @returns true when a `.svn` directory is present at or above cwd
 */
export function isSvnWorkingCopy(cwd) {
    const key = cwd ? resolve(cwd) : process.cwd();
    const cached = workingCopyCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.value;
    }
    const found = findSvnWorkingCopyRoot(key) !== null;
    workingCopyCache.set(key, { value: found, expiresAt: Date.now() + CACHE_TTL_MS });
    return found;
}
/**
 * Split a checkout URL into the project name and the branch it points at.
 *
 * SVN has no branches — only the convention that a project holds `trunk`,
 * `branches/<name>`, and `tags/<name>`. So the URL path below the repository
 * root is the whole signal, and it is read from the first of those three
 * segments:
 *
 *   root=https://host/svn  url=https://host/svn/proj/branches/2.1/src
 *                                              ^^^^ project  ^^^ branch
 *
 * Everything before that segment is the project path (its last segment is the
 * name); everything after names the branch or tag. This covers both common
 * layouts — a repository per project (`root=.../proj`, nothing before `trunk`,
 * so the name falls back to the root's own basename) and many projects in one
 * repository, as above.
 *
 * With no trunk/branches/tags segment at all — a flat or custom layout — the
 * relative path itself is reported as the branch, which is the only "where am
 * I" signal such a checkout has.
 *
 * @param url - The checkout URL (`<url>` from `svn info`)
 * @param root - The repository root URL (`<root>`), which may be absent
 * @param relativeUrl - `<relative-url>` (SVN 1.8+), e.g. `^/proj/trunk`
 * @returns `{ project, branch }`, either of which may be null
 */
export function deriveRepoAndBranch(url, root, relativeUrl) {
    if (!url) {
        return { project: null, branch: null };
    }
    const rootName = root ? basename(root.replace(/\/+$/, '')) || null : null;
    // Three ways to the repository-relative path, best first. `<relative-url>`
    // states it outright; the root prefix derives it; and with neither — both
    // `<repository>` and `<root>` are optional in info.rnc — the URL's own path
    // still carries the trunk/branches/tags segment, which is the part that
    // actually names the branch.
    const relative = relativeUrl
        ? relativeUrl.replace(/^\^?\/+/, '')
        : (root && url.indexOf(root) === 0
            ? url.slice(root.length).replace(/^\/+/, '')
            : url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '').replace(/^\/+/, ''));
    const segments = relative.split('/').filter(Boolean);
    let anchor = -1;
    for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        if (segment === 'trunk' || segment === 'branches' || segment === 'tags') {
            anchor = i;
            break;
        }
    }
    if (anchor === -1) {
        return {
            project: rootName,
            branch: segments.length > 0 ? segments.join('/') : null,
        };
    }
    const prefix = segments.slice(0, anchor);
    const kind = segments[anchor];
    return {
        project: prefix.length > 0 ? prefix[prefix.length - 1] : rootName,
        // `branches`/`tags` name what follows them; `trunk` names itself. A
        // checkout of the bare `branches` directory has nothing after it, so it
        // reports that directory rather than nothing at all.
        branch: kind === 'trunk' ? 'trunk' : (segments[anchor + 1] ?? kind),
    };
}
/**
 * Parse `svn info --xml`.
 *
 * @param xml - Raw stdout of `svn info --xml`
 * @returns `{ project, branch, revision }`, any of which may be null
 */
export function parseSvnInfoXml(xml) {
    const empty = { project: null, branch: null, revision: null };
    if (!xml) {
        return empty;
    }
    const urlMatch = /<url>([^<]*)<\/url>/.exec(xml);
    const rootMatch = /<root>([^<]*)<\/root>/.exec(xml);
    if (!urlMatch) {
        return empty;
    }
    const relativeMatch = /<relative-url>([^<]*)<\/relative-url>/.exec(xml);
    const url = decodeUrl(decodeXml(urlMatch[1]));
    const root = rootMatch ? decodeUrl(decodeXml(rootMatch[1])) : null;
    const relativeUrl = relativeMatch ? decodeUrl(decodeXml(relativeMatch[1])) : null;
    // The working-copy revision lives on <entry>; <commit revision> is the
    // last-changed revision, which is a different (and usually older) number.
    const revisionMatch = /<entry\b[^>]*\brevision="(\d+)"/.exec(xml);
    const { project, branch } = deriveRepoAndBranch(url, root, relativeUrl);
    return {
        project,
        branch,
        revision: revisionMatch ? revisionMatch[1] : null,
    };
}
/**
 * Parse `svn status --xml` into the same counter shape the git element uses.
 *
 * SVN has no index, so "staged" means *scheduled for commit* — added, deleted,
 * or replaced paths, which is what `svn commit` would send.
 *
 * `missing` (a file deleted without `svn delete`) counts as modified to match
 * git.js, which counts a worktree `D` the same way.
 *
 * **Both status columns count.** `wc-status` carries `item` (the text status)
 * *and* `props` (the property status), and a change can live in either: a
 * property conflict is `item="normal" props="conflicted"`, and a property-only
 * edit is `item="normal" props="modified"` — which is the normal state of every
 * merge root, since `svn merge` writes `svn:mergeinfo` there. Reading only
 * `item` reported those trees as clean, hiding a conflict class that blocks
 * `svn commit` outright. Tree conflicts are flagged by a third attribute, so
 * they are tested separately again.
 *
 * @param xml - Raw stdout of `svn status --xml`
 * @returns Counter object (all zero for a clean working copy)
 */
export function parseSvnStatusXml(xml) {
    const counts = { staged: 0, modified: 0, untracked: 0, conflicted: 0 };
    if (!xml) {
        return counts;
    }
    // One <wc-status> per entry. `-u` would add <repos-status>, which carries
    // the *server's* view and must never be counted — this element never passes
    // `-u`, and matching the tag name exactly keeps it that way.
    const statusTag = /<wc-status\b([^>]*)>/g;
    let match = statusTag.exec(xml);
    while (match !== null) {
        const attributes = match[1];
        const itemMatch = /\bitem="([^"]*)"/.exec(attributes);
        const propsMatch = /\bprops="([^"]*)"/.exec(attributes);
        const item = itemMatch ? itemMatch[1] : '';
        const props = propsMatch ? propsMatch[1] : '';
        if (/\btree-conflicted="true"/.test(attributes) || item === 'conflicted' || item === 'obstructed'
            || props === 'conflicted') {
            counts.conflicted += 1;
        }
        else if (item === 'added' || item === 'deleted' || item === 'replaced') {
            counts.staged += 1;
        }
        else if (item === 'modified' || item === 'merged' || item === 'missing' || item === 'incomplete') {
            counts.modified += 1;
        }
        else if (item === 'unversioned') {
            counts.untracked += 1;
        }
        else if (props === 'modified') {
            // Text unchanged, properties edited — counted last so a path already
            // scored by its `item` is never counted twice.
            counts.modified += 1;
        }
        // normal / ignored / external / none, with clean props: nothing to report.
        match = statusTag.exec(xml);
    }
    return counts;
}
/**
 * Read project name, branch, and working-copy revision.
 *
 * @param cwd - Working directory
 * @returns Info object, or null outside a working copy / on any failure
 */
export function getSvnInfo(cwd) {
    if (!isSvnWorkingCopy(cwd)) {
        return null;
    }
    const key = cwd ? resolve(cwd) : process.cwd();
    const cached = infoCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.value;
    }
    let result = null;
    try {
        result = parseSvnInfoXml(svn(['info', '--xml', '--non-interactive'], cwd, INFO_TIMEOUT_MS));
    }
    catch {
        // `svn` missing, too slow, or the path is not a working copy after all.
        result = null;
    }
    infoCache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
}
/**
 * Read working-copy status counts, memoized across renders.
 *
 * `svn status` walks the whole working copy, so on the large checkouts SVN is
 * typically used for it is the expensive part of the frame. The disk memo keeps
 * that to at most one walk per `STATUS_MEMO_TTL_MS`; a rescan that fails or
 * times out falls back to the last good counts rather than blanking the
 * element, since stale counts beat a fragment that vanishes.
 *
 * @param cwd - Working directory
 * @param sessionKey - Session key naming the cache folder (no memo without it)
 * @returns Counts, or null outside a working copy / with nothing yet measured
 */
export function getSvnStatusCounts(cwd, sessionKey) {
    if (!isSvnWorkingCopy(cwd)) {
        return null;
    }
    const key = cwd ? resolve(cwd) : process.cwd();
    // Keyed by session too: one render only ever carries one session key, but a
    // process that rendered several would otherwise serve the first session's
    // counts to the rest from this Map.
    const cacheKey = `${sessionKey ?? ''}::${key}`;
    const cached = statusCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.value;
    }
    const memo = readStatusMemo(sessionKey, key);
    let result;
    if (memo && Date.now() - memo.at < STATUS_MEMO_TTL_MS) {
        result = memo.counts;
    }
    else {
        try {
            result = parseSvnStatusXml(svn(['status', '--xml', '--non-interactive'], cwd, STATUS_TIMEOUT_MS));
            writeStatusMemo(sessionKey, key, result);
        }
        catch {
            result = memo ? memo.counts : null;
        }
    }
    statusCache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
}
/**
 * Render the SVN project name element.
 *
 * Format: repo:proj
 *
 * @param cwd - Working directory
 * @returns Formatted project name or null
 */
export function renderSvnRepo(cwd) {
    const info = getSvnInfo(cwd);
    if (!info?.project) {
        return null;
    }
    return `${paintLabel('repo:')}${paint(PALETTE.gradLow, info.project)}`;
}
/**
 * Render the SVN branch element, with the working-copy revision.
 *
 * Format: branch:trunk@12345
 *
 * The revision rides along because it is SVN's "where am I" identity — the
 * number you quote to a colleague — unlike a git SHA, which the git element
 * deliberately omits.
 *
 * @param cwd - Working directory
 * @returns Formatted branch (and revision) or null
 */
export function renderSvnBranch(cwd) {
    const info = getSvnInfo(cwd);
    if (!info?.branch) {
        return null;
    }
    const branch = `${paintLabel('branch:')}${paint(PALETTE.gradLow, info.branch)}`;
    if (!info.revision) {
        return branch;
    }
    return `${branch}${paintLabel('@')}${paint(PALETTE.gradLow, info.revision)}`;
}
/**
 * Render the SVN working-copy status element.
 *
 * Format: ✗1 +2 !3 ?1 — the git shapes minus ahead/behind, which SVN cannot
 * answer without contacting the server.
 *
 * @param cwd - Working directory
 * @param labels - Resolved HUD labels
 * @param sessionKey - Session key, for the cross-render status memo
 * @returns Formatted status or null when clean / outside a working copy
 */
export function renderSvnStatus(cwd, labels = DEFAULT_HUD_LABELS, sessionKey) {
    const counts = getSvnStatusCounts(cwd, sessionKey);
    if (!counts) {
        return null;
    }
    const { staged, modified, untracked, conflicted } = counts;
    if (staged === 0 && modified === 0 && untracked === 0 && conflicted === 0) {
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
    return parts.join(' ');
}
