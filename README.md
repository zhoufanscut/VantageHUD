# VantageHUD

A small, self-contained [Claude Code](https://claude.com/claude-code) statusline
(HUD). From the JSON Claude Code pipes to the `statusLine` command it renders the
project folder, the model with thinking effort (`opus:max`), context %,
rate limits, git (or Subversion) info, session time, and more.

- **No dependencies.** Pure Node built-ins — no `node_modules`, no native code.
- **Five built-in themes** — dark, light and near-monochrome. See them all with
  `node preview-themes.mjs`, or build your own. [Themes ↓](#themes)
- **Portable.** Clone anywhere, on macOS or Linux, with any Node `>=14.17`.
  Windows works through Git Bash or WSL — see [Windows](#windows).
- **Proxy aware.** Honors `HTTPS_PROXY` / `https_proxy` — including
  `user:pass@` credentials and `https://` proxies — for the usage/rate-limit
  API via a CONNECT tunnel (no-op when unset), and `NO_PROXY` / `no_proxy`.

## Layout

```
statusline.sh       # entry point Claude Code calls (caches + renders)
statusline.mjs      # Node launcher: installs the proxy tunnel, loads src/
find-node.sh        # locates node (PATH / nvm / fnm / mise / asdf / volta / homebrew)
preview-themes.mjs  # renders every theme as a sample line, to compare them
src/                # the renderer (ESM, Node built-ins only)
cache/              # render cache + state, one subfolder per session (gitignored)
```

## Setup

### 1. Prerequisites
- Claude Code installed (this is its statusline).
- Node `>=14.17` on the machine (`node --version`). No `npm install` needed.
- A POSIX `sh` to run the wrapper — any macOS or Linux box has one.

#### Windows
Claude Code runs the `statusLine` command through a shell, and the wrapper is a
POSIX `sh` script, so `sh` must be on `PATH`: install
[Git for Windows](https://git-scm.com/download/win) (Git Bash), or run Claude
Code inside WSL, where the Linux steps apply as written. Under Git Bash, `~` is
`%USERPROFILE%` and the clone goes to `~/.claude/hud` as below; `node` must be
on Git Bash's `PATH` too. `safeMode` is on by default, which swaps the gauge
glyphs for ASCII, and `callCounts` uses ASCII (`T:42`) on Windows and WSL unless
`callCountsFormat` says otherwise.

### 2. Get the folder
Clone it anywhere — `~/.claude/hud` is the conventional spot:
```sh
git clone https://github.com/zhoufanscut/VantageHUD.git ~/.claude/hud
```
(The scripts keep their executable bit through `git clone`, so there's nothing
to `chmod`.)

### 3. Wire it into Claude Code
Add a `statusLine` entry to **`~/.claude/settings.json`**. This is a **merge** —
keep your existing keys (`model`, `permissions`, …) and just add this one:

```jsonc
{
  // ...your existing settings...
  "statusLine": {
    "type": "command",
    "command": "sh \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/statusline.sh\" \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/statusline.mjs\""
  }
}
```

- If you cloned somewhere other than `~/.claude/hud`, put that absolute path in
  the command instead.
- `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` makes it work even with a custom config
  dir; a plain `~/.claude/hud/...` path is fine too. Keep the escaped quotes
  around each path: without them a home folder with a space in it (common on
  Windows, e.g. `C:\Users\John Doe`) splits the path and the bar stays blank.
- Add `"refreshInterval": 5` (seconds, minimum `1`) beside `"command"` if you
  want the bar to keep moving while the session is idle. Claude Code otherwise
  re-runs it only on its own events — session start, a new assistant message,
  `/compact`, a permission-mode or vim-mode change — so the session timer and
  the limit countdowns freeze between turns (the `cache:` element shows a clock
  time instead, so it does not). Each tick is served from the render
  cache in tens of milliseconds, with a full re-render (~100 ms of Node) behind it.
- Prefer a tool? Merge it with `jq`:
  ```sh
  f="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"; tmp=$(mktemp)
  jq '.statusLine = {type: "command", command: "sh \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/statusline.sh\" \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/statusline.mjs\""}' "$f" > "$tmp" &&
    cat "$tmp" > "$f" && rm -f "$tmp"
  ```
  (`cat >` writes through a symlinked `settings.json` — a dotfiles setup —
  where `mv` would replace the link with a private copy.)

### 4. (Re)start Claude Code
A new session renders the bar from the first frame. An already-open session
needs a restart to pick up the `settings.json` change.

## Verify it works
From inside the folder, feed it a sample payload:
```sh
cd ~/.claude/hud
echo '{"session_id":"t","cwd":"'"$HOME"'/example","effort":{"level":"high"},"model":{"id":"claude-opus-5-5[1m]","display_name":"Opus 5.5 (1M context)"}}' \
  | HUD_SYNC_REFRESH=1 sh statusline.sh statusline.mjs
```
Expected: a single line containing `opus:high`. The leading path is
`~/example`, taken from the sample payload's `cwd`.

## Configure (optional)
The HUD runs on sensible defaults out of the box. To customize, copy the example
to `config.json` inside the HUD folder and edit it:
```sh
cp ~/.claude/hud/config.json.example ~/.claude/hud/config.json
```
- This is the HUD's **own** config file — *not* a block in Claude Code's
  `settings.json`, and separate from the `statusLine` hook key from step 3. Every
  key is optional; omit any and its built-in default applies. `config.json` is
  gitignored, so `git pull` never clobbers your settings.
- **Edits apply on the next status-line refresh** — no Claude Code restart
  needed. The HUD notices `config.json` changed (its mtime, size or inode
  differs from the render it cached; a symlinked config is checked through
  to its target) and re-renders.
- Common knobs: `theme`, `locale` (`en` | `zh-CN`), and the
  `elements` toggles (e.g. `gitBranch`, `contextBar`, `rateLimits`, `showTokens`).
  See `config.json.example` for the full list.
- **A file that does not parse** (a trailing comma is the usual culprit) puts
  `[cfg err]` at the start of the line, and every setting falls back to its
  default until it is fixed; `HUD_DEBUG=1` prints the parser's message. A UTF-8
  byte-order mark (Windows PowerShell's `-Encoding UTF8`) is fine. An unknown or
  misspelled key is ignored — `HUD_DEBUG=1` names it, with a hint when only
  the case is wrong (`gitstatus` → `gitStatus`).
- `elementOrder` (top level, e.g. `["model", "contextBar", "pathLabel"]`)
  reorders the line: named elements come first in that order, the rest follow
  in the default order, unknown names are ignored. `layout: { "main": [...] }`
  is the strict form: only the elements it names are shown, in that order
  (repeats and unknown names dropped; an empty list counts as unset). Both
  take **element names**, which differ from the enable flags in three places
  — the default order, with each one's flag under `elements`:

  | element name | enable flag |
  | --- | --- |
  | `pathLabel` | `pathLabel` |
  | `model` | `model` (plus `effort` for the `:high` suffix) |
  | `rateLimits` | `rateLimits` (plus `spendLimit` and `otherModelWeekly`, both off by default — see below) |
  | `contextBar` | `contextBar` |
  | `promptCache` | `promptCache` (off by default — see below) |
  | `tokens` | `showTokens` |
  | `session` | `sessionHealth` |
  | `callCounts` | `showCallCounts` |
  | `gitRepo` | `gitRepo` |
  | `gitBranch` | `gitBranch` (plus `detachedHead`, off by default — see below) |
  | `gitStatus` | `gitStatus` |
- `labels` (top level) renames the fragment labels over the `locale`'s, e.g.
  `"labels": { "context": "ctx", "tokens": "tok" }`. Keys: `context`,
  `tokens`, `session`, `promptCache`, `cacheWarm`, `cacheCold` (the
  `cache:` / `warm` / `cold` words), `spendLimit` (the `spend:` word),
  `critical` and `compress` (the `CRITICAL` / `COMPRESS?`
  text after `ctx:`), `tool`, `agent`, `skill`, `staged`, `modified`,
  `untracked`, `conflict`, `ahead`, `behind`, and the `detachedHead` words
  `gitRebase`, `gitAm`, `gitMerge`, `gitCherryPick`, `gitRevert`,
  `gitBisect`.
- `usageApiPollIntervalMs` (default `90000`, minimum `30000`): how often the
  usage API is polled for the buckets the payload does not carry.
- `thresholds.contextWarning` / `contextCompactSuggestion` / `contextCritical`
  (default `70` / `80` / `85`): `ctx:` turns amber at the first, adds
  `COMPRESS?` at the second, and turns rose with `CRITICAL` at the third.
- `thresholds.sonnetWeeklyVisibility` (default `80`, `0` = always): the
  per-model weekly buckets — `sn:` (Sonnet) and, with `otherModelWeekly` on,
  any other model the usage API reports, such as `fb:` (Fable) — stay hidden
  until their usage reaches this percent. `op:` (Opus) always shows.
- **Colors** are set by `theme`, and you can define your own palettes under
  `themes` — see [Themes](#themes) below.
- `maxWidth` / `wrapMode`: the line is cut to `maxWidth` columns with `...`
  (`wrapMode: "truncate"`, the default) or broken at the ` | ` separators
  (`"wrap"`). Without `maxWidth` the width comes from the terminal when the
  renderer runs directly in one (`node statusline.mjs` by hand), else from
  `COLUMNS` when Claude Code provides it; the line is left alone otherwise —
  which is the usual case through `statusline.sh`.
- More `elements` options: `useBars` (default `false`) draws `ctx:` and the
  rate limits as gauges; `callCountsFormat` is `auto` (the default: ASCII
  `T:42` on Windows and WSL, emoji `🔧42` elsewhere), `ascii` or `emoji`;
  `safeMode` (default `true`) strips terminal control sequences and draws the
  gauges in ASCII; `maxOutputLines` (default `4`) caps the lines
  `wrapMode: "wrap"` may produce.
- `promptCache` (inside `elements`, default `false`): set it to `true` to add a
  `cache:` fragment after `ctx:` for the main conversation's prompt cache, from
  the payload's `prompt_cache`. `cache:warm(14:30)` means the cache stays warm
  until 14:30 local time; `cache:cold(161.8k)` means it has expired and the
  next request writes those 161.8k tokens to the cache again (the number is
  left out when Claude Code does not report it). It is hidden until the first
  response of a session, and when Claude Code reports that caching is off.
  The expiry is a clock time, not a countdown, so it stays right while the
  session is idle. Claude Code re-runs the status line when the cache expires,
  so it turns `cold` then without a `refreshInterval`.
- `spendLimit` (inside `elements`, default `false`): set it to `true` to add a
  `spend:` part to the rate limits when you work behind a Claude apps gateway
  that sets a spend limit for you. It reads the payload's
  `rate_limits.spend_limit` (Claude Code 2.1.251 or later):
  `spend:63%($314.12/$500.00)(25d3h)` is the share of your limit used, your
  estimated spend and the limit in US dollars, and the time until the limit's
  period resets. The dollar amounts need 2.1.284 or later on both Claude Code
  and the gateway, can lag the percent by about five minutes, and are left out
  until they arrive (always, under `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`).
  Past the limit the percent keeps counting (`spend:104%`); the gateway then
  refuses requests until the reset. Hidden with `rateLimits` off.
- `otherModelWeekly` (inside `elements`, default `false`): set it to `true` to
  show the weekly buckets of models other than Sonnet and Opus, such as `fb:`
  for Fable, which the usage API now reports only in its `limits[]` list. The
  label is the model name's first letter plus the first consonant after it.
  Each one is hidden until it reaches `thresholds.sonnetWeeklyVisibility`, like
  `sn:`. `sn:` and `op:` show without this flag.
- `detachedHead` (inside `elements`, default `false`): set it to `true` to
  keep the `branch:` fragment when git's HEAD is detached — during a rebase,
  a bisect, or after checking out a tag or a commit — where it is otherwise
  hidden. `branch:@v1.0` names the tag (or branch, or remote-tracking branch)
  you checked out, as long as HEAD has not moved since; otherwise
  `branch:@a1b2c3d` shows the commit's first 7 sha digits. During a rebase it
  names the branch being rebased and the step, `branch:feat (rebase 2/3)`;
  `(am 1/2)`, `(bisect)`, `(merge)`, `(cherry-pick)` and `(revert)` mark the
  other operations git can stop in. It reads files in the `.git` directory and
  costs no extra `git` call (one, `rev-parse --short HEAD`, in a reftable
  repository, which then shows the sha rather than a tag name). SVN checkouts
  are not affected.
- `modelFormat` (inside `elements`) sets how the model name reads: `short`
  (`opus`, the default), `versioned` (`opus 5.5`), or `full` (raw id,
  `claude-opus-5-5[1m]`). The `:effort` suffix is a separate `effort` toggle.
- No file needed for a quick test: `HUD_THEME=ember` overrides the theme, and
  `HUD_CONFIG=/abs/path/config.json` points the HUD at a config elsewhere.

## Themes

Five palettes ship with the HUD. To see them all in your own terminal — the only
way to really judge them — run:

```sh
node ~/.claude/hud/preview-themes.mjs
```

| theme | look | assumes |
| --- | --- | --- |
| `aurora` **(default)** | cool slate, soft cyan-teal accents — Nord / Tokyo-Night family | dark terminal |
| `ember` | warm, gold and orange — Gruvbox family | dark terminal |
| `nebula` | vivid, mauve and pink — Catppuccin Mocha family | dark terminal |
| `graphite` | near-monochrome; only the usage ramp carries hue, for a HUD that recedes | dark terminal |
| `daylight` | GitHub-light family — every color reads on white (`sep` aside, which is a hairline) | **light terminal** |

Pick one in `config.json`:

```json
{ "theme": "nebula" }
```

Or preview just that one, without touching a file:

```sh
node ~/.claude/hud/preview-themes.mjs nebula
```

`HUD_THEME` also picks the theme, and wins over `config.json`. To make the
*live* HUD use it that way you have to `export HUD_THEME=nebula`
**before** starting Claude Code — the statusline is spawned with Claude Code's
launch environment, so exporting it in an already-running session changes
nothing. Editing `config.json` is the reliable way, and it is also the only one
that forces an immediate re-render: the shell wrapper bypasses its cache when
`config.json` changes, so an env change would land a frame late.

**On a light terminal, use `daylight`.** The other four are built for a dark
background and wash out on white.

### Preview options

```sh
node preview-themes.mjs                # every theme, bundled and your own
node preview-themes.mjs nebula ember   # just these
node preview-themes.mjs --depth=0      # how it degrades on a 16-color terminal
node preview-themes.mjs --ascii        # bar glyphs as safeMode renders them
```

The sample values are made up so every theme shows identical content — it is a
color comparison, not a live HUD. Your own themes from `config.json` show up too.

### Color depth

The HUD picks truecolor, 256 or 16 colors from the environment, first match wins:

1. `HUD_COLOR_DEPTH` = `2` (truecolor), `1` (256), `0` (16) or `none`.
2. `FORCE_COLOR` = `0` turns color off; `1`/`2`/`3` is a floor of 16 / 256 /
   truecolor.
3. `NO_COLOR` (any non-empty value) turns color off.
4. `COLORTERM=truecolor` or `24bit`, `WT_SESSION` (Windows Terminal), or
   `TERM_PROGRAM` = `iTerm.app` / `vscode` / `WezTerm` → truecolor.
5. `TERM=dumb` → no color; a `TERM` with `256`, or a bare `xterm`/`screen`/`tmux`
   → 256; anything else → 16.

SSH does not forward `COLORTERM`, so a truecolor terminal reached over SSH gets
256 colors. To get truecolor there, set `HUD_COLOR_DEPTH=2` (or
`COLORTERM=truecolor`) under `env` in Claude Code's `settings.json`. With no
color, bold and resets are still printed.

### What each color paints

A palette is exactly these 10 **tokens**. Several do double duty, which is worth
knowing before you change them:

| token | paints |
| --- | --- |
| `text` | the cwd path |
| `label` | every `xxx:` prefix, `(reset)` tails, the `callCounts` numbers |
| `faint` | `($spent/$limit)`, the stale `*`, the approximate `~` of `token:~1.20M`, `[API 429]` |
| `sep` | the ` \| ` separator **and** the empty gauge track (`░`) |
| `gradLow` | usage under 70%, **and** the `repo:` / `branch:` / `token:` values, effort `max`, and `cache:warm` |
| `gradMid` | usage 70–84%, `[API auth]` / `[API err]`, effort `high`, `cache:cold` |
| `gradHigh` | usage 85% and over, conflict counts, effort `low` |
| `add` | staged / ahead counts |
| `del` | modified / behind counts |
| `track` | untracked counts |

The usage ranges are the defaults. `ctx:` cuts at
`thresholds.contextWarning` / `contextCritical` instead (70 / 85 unless you
change them); the `5h:` / `7d:` / weekly gauges always cut at 70 / 85.

So a very dim `sep` also dims every empty gauge bar, and `gradLow` sets both the
"all calm" color and your repo/branch text.

### The bundled palettes

Handy for forking one — copy a column, change what you want:

| token | `aurora` | `ember` | `nebula` | `graphite` | `daylight` |
| --- | --- | --- | --- | --- | --- |
| `text` | `#c8d3e8` | `#ebdbb2` | `#cdd6f4` | `#e6e6e6` | `#24292f` |
| `label` | `#8fd0d8` | `#a89984` | `#cba6f7` | `#9e9e9e` | `#0550ae` |
| `faint` | `#6e7896` | `#928374` | `#6c7086` | `#7d7d7d` | `#6e7781` |
| `sep` | `#48506a` | `#665c54` | `#45475a` | `#3f3f3f` | `#d0d7de` |
| `gradLow` | `#72d3c3` | `#969619` | `#94e2d5` | `#b0b0b0` | `#0a7c5a` |
| `gradMid` | `#e6c38d` | `#f1bf3c` | `#f9e2af` | `#b8964f` | `#966d00` |
| `gradHigh` | `#e0909e` | `#fb4934` | `#f38ba8` | `#cd6a6a` | `#cf222e` |
| `add` | `#8fd0b8` | `#969619` | `#a6e3a1` | `#8fa88f` | `#116329` |
| `del` | `#e0909e` | `#fb4934` | `#f38ba8` | `#b08f8f` | `#cf222e` |
| `track` | `#8dc2d6` | `#fe8019` | `#89b4fa` | `#8f9db0` | `#8250df` |

### Your own theme

Define palettes under `themes`, then select one with `theme`. Set any subset of
the 10 tokens as `#rrggbb`; the rest come from `base` (another palette, default
`aurora`):

```json
{
  "theme": "mine",
  "themes": {
    "mine": { "base": "ember", "gradHigh": "#e06c75" }
  }
}
```

That is ember with a different alert color. `config.json.example` carries an entry
with all 10 tokens spelled out if you would rather start from a full palette.

- **Retint a bundled theme in place** by naming your palette after it —
  `"themes": { "ember": { "label": "#ff0000" } }` is ember with red labels, since
  `base` defaults to the bundled palette of the same name.
- **Names and keys are case-insensitive**; `base` chains up to 16 deep.
- **Colors only.** Glyphs, the ` \| ` separator and the 70/85 cut points are not
  part of a theme. The `ctx:` cut points live under `thresholds`, so its color
  can never disagree with the `CRITICAL` text beside it.
- A value that isn't `#` plus exactly 6 hex digits keeps the inherited color
  rather than breaking the line. Run with `HUD_DEBUG=1` to see what was rejected
  and why.

## Where the rate limits come from
`5h:` and `7d:` come from the payload's `rate_limits`, which current Claude
Code sends when you are logged in with a Claude.ai subscription. Everything
else in that fragment — the per-model weekly buckets (`op:`, `sn:`, and with
`otherModelWeekly` on `fb:`, …), `extra:`, and `5h`/`7d` on a Claude Code too
old to send them — comes from
Anthropic's usage API, called with the same Claude.ai login, read-only (the HUD
never refreshes a token). The API is skipped with an API key and no
Claude.ai login, with `ANTHROPIC_BASE_URL` pointing at another host, and under
`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`; you then see only what the
payload carries, often no rate-limit fragment at all. Behind a Claude apps
gateway with a spend limit, that is the opt-in `spend:` part (`spendLimit`
above).

## Behind a proxy
```sh
export HTTPS_PROXY=http://proxy.example.com:8080
# with credentials (percent-encode reserved characters in the password):
export HTTPS_PROXY=http://alice:p%40ss@proxy.example.com:8080
```
The launcher tunnels the HUD's HTTPS calls through it automatically. `https://`
proxies are supported too, and a bare `host:port` is read as `http://host:port`.
A SOCKS proxy (`socks5://…`) is not: the HUD then goes direct. A host covered
by `NO_PROXY` / `no_proxy` (`*`, a host, or a domain such as `.anthropic.com`,
optionally with `:port`; no CIDR ranges) goes direct too. A proxy that refuses the tunnel (407/403) or never
answers (10 s bound) just leaves the rate-limit fragment on the payload's own
numbers — or `[API err]` on a Claude Code too old to send them.

## Update
```sh
git -C ~/.claude/hud pull
```

## Notes
- The leading path is the project folder: the root of the git repository or
  SVN working copy the session is in (so a session in `packages/foo` still
  shows the repo root), else the session's own directory. It shows `~` in
  place of `$HOME` (or `%USERPROFILE%`) to stay compact.
- `repo:` / `branch:` / working-tree counts cover **git and Subversion**. In an
  SVN checkout the branch comes from the URL convention (`trunk`,
  `branches/<name>`, `tags/<name>`) and carries the working-copy revision, e.g.
  `branch:2.1@12345`. Both `svn` calls are local — nothing contacts the server,
  which is why SVN shows no `⇡`/`⇣` ahead/behind — and the working-copy scan is
  cached for up to 30s (sooner after `svn add`/`delete`/`revert`) so a large
  checkout is not re-walked every frame. A git repository whose `git status`
  takes 300 ms or more is cached the same way (sooner after staging or a
  commit); a faster one is re-read every frame. "Sooner" holds only while a
  scan takes under a second: a slower tree is re-scanned at most once per 10×
  its scan time, which past a 3 s scan is longer than 30s (a 28 s scan: about
  4.7 min).
- Runtime files live in a per-session subfolder of `cache/`, i.e.
  `cache/<session>/<name>.json` (the render cache, the token/call-count tally
  memos, the git/SVN status memo, and the context-stabilization snapshot
  grouped per session). A few sit at the root of `cache/`, shared by every
  session: the usage-API cache (`.usage-cache-anthropic.json`, or
  `.usage-cache-anthropic-<hash>.json` per `CLAUDE_CONFIG_DIR`; a `.lock`
  beside it while a fetch runs), the daily-prune stamp `.last-prune`, and the
  `.vantagehud-cache` marker — so deleting one session's folder does not reset the rate-limit
  data. Centralized under the HUD install dir, never inside your project;
  safe to delete anytime. Session folders
  idle for roughly two weeks are pruned automatically (14 days on macOS, 15 on
  Linux, where `find` counts whole days). If the install's `cache/` is not
  writable (a read-only or shared install), the HUD uses
  `${XDG_CACHE_HOME:-~/.cache}/vantagehud` instead.
- If a render fails, the renderer's stderr is kept as
  `cache/<session>/statusline.err` (cleared by the next successful render) —
  check it when the bar shows `[HUD] HUD error`.
- Optional env: `HUD_CONFIG` (path to the config file; default is the HUD
  install's own `config.json`), `HUD_THEME` (any bundled or user theme name, overrides
  `config.json`), `HUD_CACHE_DIR` (override that cache/state dir; default is the
  HUD install's own `cache/`. Give it a folder of its own: the HUD cleans up
  only a folder it created itself, marked by a `.vantagehud-cache` file, and
  leaves an existing one unswept), `HUD_CACHE_MAX_AGE_DAYS` (idle-session
  retention, default 14), `HUD_LOCK_STALE_SECONDS` (age after which another
  frame may take over a render lock whose owner has exited, default 10; a
  render still running keeps its lock for up to 120 s), `HUD_SYNC_USAGE_BUDGET_MS` (how long a
  synchronous render — the first one per session, or one after a config edit —
  waits on the usage API before rendering with the cached numbers; default
  1000, `0` waits the full 10 s timeout; it does not wait at all when the
  payload already carries both the 5h and 7d windows), `HUD_SYNC_REFRESH=1` (testing only:
  bypass the render cache and render this payload synchronously; set globally
  it would cost every frame a full Node render), `HUD_DEBUG=1` (verbose; the
  wrapper also names the path each frame took, as `[HUD sh] …` on stderr).

## Credits
VantageHUD started from, and still carries code derived from, two MIT-licensed
projects:
- [claude-hud](https://github.com/jarrodwatts/claude-hud) by Jarrod Watts
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) by Yeachan Heo

Their copyright notices are kept in [`LICENSE`](LICENSE).

## License
[MIT](LICENSE).
