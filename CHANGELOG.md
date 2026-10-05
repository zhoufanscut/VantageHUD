# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The fixes from a full review: per-model weekly caps that render again, a
`token:` that says when it is a lower bound, a wrapper that cannot delete your
folders or lose its cached line, and a faster frame.

### Added

- **Per-model weekly caps from the usage API's `limits[]`.** The API now
  reports them only there, so `sn:`/`op:` had stopped rendering and other
  models never showed. Any model now gets a bucket, labelled by its first
  letter and the first consonant after it — `fb:91%(21h8m)` for Fable — and
  hidden below `thresholds.sonnetWeeklyVisibility` like `sn:` (`op:` still
  always shows). `limits[]` also fills an absent `5h`/`7d`.
- **`token:~1.20M`**: a faint `~` marks the total as a lower bound. From Claude
  Code 2.1.283 most subagent calls never write their final usage row, and the
  real count is on disk nowhere, so nearly every multi-agent session on
  current Claude Code shows it. Lead transcripts are not affected.
- **`[cfg err]`** at the start of the line when `config.json` exists but does
  not parse. Every setting still falls back to its default, but this used to
  happen silently. `HUD_DEBUG=1` prints the parser's message and names unknown
  config keys, with a hint when only the case is wrong.
- **Color control.** `HUD_COLOR_DEPTH=0|1|2|none` picks the depth; `NO_COLOR`,
  `FORCE_COLOR` (`0`–`3`) and `TERM=dumb` are honored; Windows Terminal
  (`WT_SESSION`) and iTerm2 / VS Code / WezTerm (`TERM_PROGRAM`) count as
  truecolor. `preview-themes.mjs --depth` uses the same override.
- **Label keys `session`, `critical` and `compress`**, so `zh-CN` now
  localizes `session:` and the `CRITICAL` / `COMPRESS?` text after `ctx:`
  (会话 / 危急 / 建议压缩), and `labels` can rename them.
- **`NO_PROXY` / `no_proxy`** is honored (`*`, a host, or a domain suffix,
  optionally with `:port`). A bare `host:port` proxy is read as `http://`, an
  IPv6 proxy works, and a SOCKS proxy is ignored (the request goes direct).
- **`HUD_SYNC_USAGE_BUDGET_MS`** (default `1000`): how long a synchronous
  render waits on the usage API before it renders with the cached numbers. A
  synchronous render whose payload already has both `5h` and `7d` does not
  wait at all (1167 → 140 ms against a hung server).
- `find-node.sh` also finds node under `$NVM_DIR`, XDG nvm, `$FNM_DIR`, mise,
  asdf and Volta, and probes each default location without its env var — a
  GUI-launched Claude Code often lacks them.
- When the renderer fails to load on a Node older than 14.17, the line reads
  `[HUD] Node >=14.17 required (found vX)` instead of a bare `SyntaxError`.
- `HUD_DEBUG=1` also makes `statusline.sh` name the path each frame took
  (`[HUD sh] …`) and pass on a good render's stderr.

### Changed

- **`ctx:` is colored by your thresholds.** The color cut at a fixed 70/85
  while the `COMPRESS?` / `CRITICAL` text followed `config.json`, so
  `thresholds.contextWarning` did nothing and `65% CRITICAL` could show in the
  calm color.
- **256-color output uses the true nearest xterm index.** Every bundled theme
  looks slightly different at 256 colors, and a user color with a `255`
  channel no longer turns near-black (`#ff0000` was index 232).
- **`modelFormat: "versioned"`** reads the version after any family
  (`Mythos 5` → `mythos 5`, `anthropic/claude-opus-5.5` → `opus 5.5`), and a
  Bedrock inference-profile ARN renders as `bedrock`.
- **One usage cache per account.** With `CLAUDE_CONFIG_DIR` set the cache is
  `cache/.usage-cache-anthropic-<hash>.json`; one shared file showed one
  account's numbers in another account's session. The default config dir keeps
  `.usage-cache-anthropic.json`.
- **The usage API is skipped** under `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` /
  `_FOUNDRY`, whose traffic does not draw on a subscription's limits. An empty
  `ANTHROPIC_BASE_URL` counts as unset, as in Claude Code.
- **A 401 shows `[API auth]`** (a 403 stays `[API err]`: the region block
  answers 403 too). A 429's numeric `Retry-After` is honored, up to 1 h, and no
  429 backoff is shorter than the poll interval.
- `usageApiPollIntervalMs` has a 30 s floor (it was 1 s, i.e. every render).
- **`HUD_LOCK_STALE_SECONDS`** now applies only when the render lock's owner
  has exited. A render still running keeps its lock for up to 120 s.
- **A slow git repo is memoized like SVN.** One whose `git status` takes
  300 ms or more is cached in `cache/<session>/git-status.json` (refreshed
  sooner after staging or a commit while a walk takes under 1 s; a slower
  tree is re-walked at most every 10× its walk time, which can exceed 30 s);
  a faster one is still read every frame.
  Once a memo exists, git and SVN walks in the background get 30 s instead of
  the first walk's short timeout, so a working copy slower than that shows
  counts.
- **A cwd inside an `svn:externals` directory or a nested checkout** shows that
  working copy, not the outer one.
- **A symlinked repo keeps your path.** The leading path showed the link's
  target (losing `~` when it was outside `$HOME`); it now keeps the session's
  spelling, unless the link points into the tree.
- An unwritable install `cache/` falls back to
  `${XDG_CACHE_HOME:-~/.cache}/vantagehud`.
- **The wrapper's cache files are private** (`umask 077`), like the Node
  side's 0600 writes: `stdin.json` is the whole payload. This matters if you
  share one cache dir between users.
- The README's `statusLine` command now quotes both paths, so a home folder
  with a space in it (common on Windows) works. Your `settings.json` is not
  changed: if your home path has a space, update the command by hand.
- `HUD_CONFIG` is no longer trimmed, so the wrapper and Node watch the same
  file; a whitespace-only value means the defaults.
- **Faster frames.** A cache-hit render no longer loads `crypto`, nor
  `https`/`http`/`tls` unless a proxy is set (p50 126 → 93 ms without one); the transcript tail is read only when
  `ctx:` needs it, and backwards (5.5 MB transcript: ~28 → ~2 ms); the
  wrapper's hot path runs ~12 processes instead of ~32 (21.8 → 12.9 ms); and a
  directory outside any repo spawns 1 git process instead of 5.

### Fixed

- **`HUD_CACHE_DIR=~/.cache` deleted your folders.** The daily prune removes
  every first-level folder past the retention age. Every sweep now runs only in
  a cache dir carrying a `.vantagehud-cache` marker, which the wrapper writes
  only in a dir it created and in the install's own `cache/`. A pre-existing
  `HUD_CACHE_DIR` is never swept unless you create that file in it.
- **A killed wrapper lost the cached line.** A Windows session showed
  `[HUD] Starting...` for minutes: every frame took the slow synchronous path
  and was killed the same way. Node now writes the line to the cache itself as
  soon as it has one. A synchronous render never runs `svn status` (it serves
  the memo), a failed walk backs off 5 minutes, and orphaned `.tmp` files are
  swept by one `find` off the hot path.
- **The frame at a rate-limit reset showed the line from before it.** Node
  records the payload's next reset / prompt-cache expiry
  (`cache/<session>/statusline.deadline`), and once it has passed the next
  frame renders synchronously.
- **A payload that arrived during a render was dropped**, so an idle session
  could show a frame two payloads old. It now sets `render.dirty` and the
  running render renders again, until no payload is waiting.
- **Two renders could run side by side.** The render lock now names its owner
  and is released only by it, and a takeover is serialized; the older render
  used to land last, over the newer line. The Node-side locks got the same
  treatment: two processes reaping one stale lock could both hold it, and a
  lock whose PID was reused was never reaped.
- **Config edits in the same second as a render were missed**, and a config
  dated in the future forced a synchronous render on every frame. Changes are
  now detected by an `mtime:size:inode` stamp compared for inequality, taken
  through a symlinked config to its target.
- **`5h:92%` right after the window reset.** A window whose reset time has
  passed is hidden instead of refilled, unmarked, from the API cache.
- **The usage numbers.** An account with no five-hour window no longer shows a
  made-up `5h:0%`; a 200 the HUD cannot read keeps the last good numbers;
  `extra:` hides when extra usage is turned off; a peer fetching the usage API
  no longer puts an invented `[API err]` on the line; any lock error
  (`EACCES`, `ENOSPC`, `EPERM`) serves the cache; and the cache served while
  another process holds the lock is capped at 15 minutes old instead of any
  age.
- **A cut-off or trickling usage response** left the renderer printing nothing
  and an orphaned lock. There is now a 10 s wall-clock cap.
- **`token:` ran backwards past 512 subagent files**, because only the 512
  largest were summed. Every file is summed now; only the parsing per frame is
  bounded.
- **A transcript past ~512 MiB hid `token:`, the call counts and `session:`**
  on every frame (a V8 string limit). It is read in 8 MiB slices, which also
  lowers peak memory.
- **One bad value blanked the whole line** as `[HUD] HUD error`. Each element
  now fails on its own; a non-string `model`, `cwd` or `transcript_path` in the
  payload is treated as absent.
- **Control characters** in a path, model, repo, branch or worktree name
  render as `?`; a newline in a folder name used to split the line, and an
  escape sequence in an SVN repository name could reach the terminal.
- **`~` shortening** works for Windows paths and when `HOME` ends in a slash.
- **`gitStatus`** counts a typechange and a `git add -N` path; an `origin`
  URL ending in `/` gives a repo name; branch and status work on git older
  than 2.22 / 2.15.
- **Linked worktrees found no transcript** when the main repo path held `_`, a
  space or a drive colon: project folders are now named the way Claude Code
  names them.
- **Width**: `stringWidth` counts skin tones and variation selectors as zero
  width, flags as 2, and wide symbols such as ✅ as 2, so `maxWidth` no longer
  overflows on them. A text-default symbol made emoji by VS16 (❤️) still
  counts 1.
- A cache file vanishing mid-frame could abort the wrapper on GNU `stat`
  (a blank bar for that frame).
- `token:` printed `1000.0k` for 999,950–999,999; it switches to `M` there.
- `layout.main` drops repeated names, and an empty list counts as unset (it
  printed an empty line). A non-numeric `maxOutputLines` takes the default
  instead of printing `... (+NaN lines)`.
- A UTF-8 byte-order mark in `config.json` (Windows PowerShell) no longer
  makes the whole file ignored.
- An atomic write cut short by a full disk is discarded instead of committed
  truncated.

### Removed

- The `labels.thinking` and `labels.model` keys: nothing read them. A config
  that sets them is ignored, and `HUD_DEBUG=1` names them.
- The `mo:` (monthly) bucket, unset since the z.ai provider was removed, and
  the migration of a legacy `.usage-cache.json` no version ever wrote.

## [0.5.0] - 2026-09-05

A usage client that can no longer log you out, exact call counts at any
transcript size, a sturdier proxy tunnel, and the review findings that came
with them.

### Changed

- **The HUD no longer refreshes an expired OAuth token.** Refresh tokens are
  single-use: a refresh from a statusline hook revokes the access token Claude
  Code itself holds and forces a re-login
  ([anthropics/claude-code#42603](https://github.com/anthropics/claude-code/issues/42603)).
  Credentials are now strictly read-only. While a token is expired the last
  good numbers show stale-marked (`*`) for up to 15 minutes, then
  `[API auth]`, until Claude Code refreshes the store itself. Current Claude
  Code carries `rate_limits` in the payload, which take precedence, so the
  `5h`/`7d` figures are unaffected.
- **`session:` and the reset countdowns share one compact duration format**:
  `45m`, `3h12m`, `2d5h`. The session timer no longer reads raw minutes (a
  resumed conversation showed `37683m`), and a countdown under an hour reads
  `56m` instead of `0h56m`.
- **`repo:` and the worktree suffix come from the payload** when Claude Code
  supplies `workspace.repo.name` / `workspace.git_worktree`, with git as the
  fallback. A frame in a git repo spawns 3 git processes instead of 6.
- **Terminal-width auto-detection honors `wrapMode`.** When `COLUMNS` is
  available the line is truncated to it by default; it switched to wrapping at
  separators before. `wrapMode: "wrap"` restores that.
- Renamed to **VantageHUD** in the README and `package.json`, matching the
  repository.
- `session:` hides when there is no transcript instead of reading `0m`.

### Fixed

- **`find-node.sh` picked nvm/fnm versions by name order**, so `v9.x` beat
  `v20.x`. Versions are now compared numerically.
- **The smoke test showed the previous frame.** With a cached render present,
  `HUD_SYNC_REFRESH=1` printed the cached line first and only then re-rendered,
  so the documented verification command reflected the *last* payload, not the
  one piped in — a code change looked like it had no effect until the second
  run. It now bypasses the cache and prints the fresh render.
- **`callCounts` truncated on large transcripts.** The tool/agent/skill counts
  were read from the last 4 MiB of the lead transcript, so on any larger
  session they undercounted (measured on a 4.9 MB transcript: 442 of 494 tool
  calls, 2 of 3 agent calls) and could run backwards as the window slid — the
  same defect 0.4.0 fixed for `token:`. They now come from the same incremental,
  memoized whole-file tally, and so does the session start.
- **A `[HUD] run /setup to install properly` line pointed at a command this
  project does not have.** Any uncaught render error now prints
  `[HUD] HUD error - check stderr`, with the stack in
  `cache/<session>/statusline.err`.
- **Proxy tunnel.** Credentials in `HTTPS_PROXY` (`http://user:pass@proxy:3128`)
  are sent as `Proxy-Authorization`, `https://` proxies are dialed over TLS,
  a CONNECT the proxy refuses (407, 403) fails the request cleanly instead of
  attempting a TLS handshake on the proxy's error page, and a proxy that
  accepts the connection but never answers the CONNECT no longer hangs the
  render forever (10 s bound; reproduced before the fix).
- **Fresh payload rate limits were marked stale.** When the usage API fell back
  to cached data (network error, or now an expired token), its `stale` flag
  also painted the `*`/`~` marker on the `5h`/`7d` values that had just
  arrived live in the payload. The flag is now dropped whenever the payload
  supplies those buckets. Relatedly, a payload carrying only one of the two
  windows no longer wipes the other window's API value (latent: Claude Code
  sends both), and a rate-limit set with neither window renders nothing
  instead of `5h:NaN%`.
- **`gitStatus` vanished on large untracked trees.** `git status --porcelain`
  ran with `execFileSync`'s 1 MiB default `maxBuffer`, which throws rather
  than truncates — reproduced with 16,000 untracked files (1.2 MB of output):
  the fragment silently disappeared. Raised to 16 MiB, as `svn status`
  already was.

### Removed

- `cache/<session>/hud-state.json`. The session start it persisted is now part
  of the tally memo (`lead-tokens.json`); leftover files are inert and go with
  their session folder.

## [0.4.0] - 2026-08-23

Themes you can pick and write yourself, Subversion support, and a `token:`
counter that is finally correct.

### Added

- **Three more bundled themes**, bringing the total to five: `nebula` (vivid
  mauve and pink, Catppuccin Mocha family), `graphite` (near-monochrome — only
  the usage ramp carries hue), and `daylight` (GitHub-light family, the first
  palette built for a **light** terminal background). `aurora` remains the
  default.
- **Custom themes**, defined under a new `themes` key in `config.json` and
  selected by `theme` (or `HUD_THEME`). A palette sets any subset of the 10
  color tokens as `#rrggbb`; the rest are inherited from `base`, which defaults
  to the palette's own name when it shadows a bundled theme — so naming yours
  `ember` retints ember in place. Colors only: glyphs, the separator and the
  70/85 thresholds stay out of a theme, so a color can never disagree with the
  `COMPRESS?` text beside it.
- **`preview-themes.mjs`**, which renders every theme — bundled and your own —
  as a sample line so they can be compared in one screen. `--depth=0|1|2`
  previews the color-depth fallbacks, `--ascii` previews `safeMode`'s glyphs.
- **Subversion checkouts** now fill the `repo:`, `branch:` and status slots,
  under the same three config keys as git — there are no `svn*` flags. The
  branch is parsed from the checkout URL (`trunk`, `branches/<name>`,
  `tags/<name>`) with the revision appended: `branch:2.1@12345`. Both
  `wc-status` columns are counted, so a property-only change no longer reads as
  clean — the normal state of every merge root, since `svn merge` writes
  `svn:mergeinfo` there. Git wins ties, and a git checkout never spawns `svn`.
- A `## Themes` section in the README documenting all five palettes, their hex
  values, and what each of the 10 color tokens paints.

### Fixed

- **`token:` counted every API call 2–4 times.** Claude Code writes one
  transcript row per assistant content block — `thinking`, `text`, each
  `tool_use` — all sharing one `message.id` and each carrying that call's usage.
  Summing rows inflated the total by a median 2.46× (max 4.11×) across 159
  transcripts.
- **`token:` truncated long sessions.** The lead transcript was read from its
  last 4 MiB but published as a complete session total — 739,480 against a true
  1,910,334 on a 25.4 MB transcript. Because the window was a fixed byte count,
  one large tool result could evict usage rows and drive the counter
  *backwards*. Counting now runs through a single incremental, de-duplicating
  tally shared by the lead and every teammate transcript.
- **Workflow subagents scored zero.** Workflow-tool ("ultracode") agents nest a
  directory deeper than Agent-tool teammates, so the flat listing never saw
  them. On a live 30-agent session `token:` read 205k against 872k of real
  usage — 76% invisible, exactly when the number matters most.
- **`gitStatus` scored unmerged paths as staged.** They now count as conflicts.

### Removed

- **The `promptTime` element.** It gauged prompt-cache age against a hardcoded
  5-minute TTL and turned red at 4m15s, but every cache-creation token measured
  on disk is `ephemeral_1h` — so it cried "cold cache" 12× too early.

## [0.3.0] - 2026-07-05

First public release — a small, self-contained statusline for Claude Code that
shows the model, thinking effort, context, rate limits, and git at a glance.

[Unreleased]: https://github.com/zhoufanscut/VantageHUD/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/zhoufanscut/VantageHUD/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/zhoufanscut/VantageHUD/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zhoufanscut/VantageHUD/releases/tag/v0.3.0
