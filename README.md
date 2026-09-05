# claude-statusline

A small, self-contained [Claude Code](https://claude.com/claude-code) statusline
(HUD). From the JSON Claude Code pipes to the `statusLine` command it renders the
working folder, the model with thinking effort (`opus:max`), context %,
rate limits, git (or Subversion) info, session time, and more.

- **No dependencies.** Pure Node built-ins — no `node_modules`, no native code.
- **Five built-in themes** — dark, light and near-monochrome. See them all with
  `node preview-themes.mjs`, or build your own. [Themes ↓](#themes)
- **Portable.** Clone anywhere, on macOS or Linux, with any Node `>=14.17`.
- **Proxy aware.** Honors `HTTPS_PROXY` / `https_proxy` — including
  `user:pass@` credentials and `https://` proxies — for the usage/rate-limit
  API via a CONNECT tunnel (no-op when unset).

## Layout

```
statusline.sh       # entry point Claude Code calls (caches + renders)
statusline.mjs      # Node launcher: installs the proxy tunnel, loads src/
find-node.sh        # locates node (PATH / nvm / fnm / homebrew)
preview-themes.mjs  # renders every theme as a sample line, to compare them
src/                # the renderer (ESM, Node built-ins only)
cache/              # render cache + state, one subfolder per session (gitignored)
```

## Setup

### 1. Prerequisites
- Claude Code installed (this is its statusline).
- Node `>=14.17` on the machine (`node --version`). No `npm install` needed.

### 2. Get the folder
Clone it anywhere — `~/.claude/hud` is the conventional spot:
```sh
git clone <your-repo-url> ~/.claude/hud
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
    "command": "sh ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/statusline.sh ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hud/statusline.mjs"
  }
}
```

- If you cloned somewhere other than `~/.claude/hud`, put that absolute path in
  the command instead.
- `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` makes it work even with a custom config
  dir; a plain `~/.claude/hud/...` path is fine too.
- Add `"refreshInterval": 5` (seconds, minimum `1`) beside `"command"` if you
  want the bar to keep moving while the session is idle. Claude Code otherwise
  re-runs it only on its own events — session start, a new assistant message,
  `/compact`, a permission-mode or vim-mode change — so the session timer and
  the limit countdowns freeze between turns. Each tick is served from the render
  cache in tens of milliseconds, with a full re-render (~150 ms of Node) behind it.
- Prefer a tool? Merge it with `jq`:
  ```sh
  f=~/.claude/settings.json; tmp=$(mktemp)
  jq '.statusLine = {type:"command", command:"sh ~/.claude/hud/statusline.sh ~/.claude/hud/statusline.mjs"}' "$f" > "$tmp" && mv "$tmp" "$f"
  ```

### 4. (Re)start Claude Code
A new session renders the bar from the first frame. An already-open session
needs a restart to pick up the `settings.json` change.

## Verify it works
From inside the folder, feed it a sample payload:
```sh
cd ~/.claude/hud
echo '{"session_id":"t","cwd":"'"$HOME"'/example","effort":{"level":"high"},"model":{"id":"claude-opus-4-8","display_name":"Opus 4.8"}}' \
  | HUD_SYNC_REFRESH=1 sh statusline.sh statusline.mjs
```
Expected: a single line containing `opus:high` (the leading
path is your working directory).

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
  needed. The HUD notices `config.json` changed (by mtime) and re-renders.
- Common knobs: `theme`, `locale` (`en` | `zh-CN`), and the
  `elements` toggles (e.g. `gitBranch`, `contextBar`, `rateLimits`, `showTokens`).
  See `config.json.example` for the full list.
- `elementOrder` (top level, e.g. `["model", "contextBar", "pathLabel"]`)
  reorders the line: named elements come first in that order, the rest follow
  in the default order, unknown names are ignored.
- **Colors** are set by `theme`, and you can define your own palettes under
  `themes` — see [Themes](#themes) below.
- `maxWidth` / `wrapMode`: the line is cut to `maxWidth` columns with `...`
  (`wrapMode: "truncate"`, the default) or broken at the ` | ` separators
  (`"wrap"`). Without `maxWidth` the width comes from `COLUMNS` when Claude
  Code provides it; the line is left alone otherwise.
- `modelFormat` (inside `elements`) sets how the model name reads: `short`
  (`opus`, the default), `versioned` (`opus 4.8`), or `full` (raw id,
  `claude-opus-4-8`). The `:effort` suffix is a separate `effort` toggle.
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

Or look at one without touching a file — `HUD_THEME` wins over `config.json`:

```sh
HUD_THEME=nebula node ~/.claude/hud/preview-themes.mjs
```

To make the *live* HUD use it that way you have to `export HUD_THEME=nebula`
**before** starting Claude Code — the statusline is spawned with Claude Code's
launch environment, so exporting it in an already-running session changes
nothing. Editing `config.json` is the reliable way, and it is also the only one
that forces an immediate re-render: the shell wrapper bypasses its cache on
`config.json`'s mtime, so an env change would land a frame late.

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

### What each color paints

A palette is exactly these 10 **tokens**. Several do double duty, which is worth
knowing before you change them:

| token | paints |
| --- | --- |
| `text` | the cwd path |
| `label` | every `xxx:` prefix, `(reset)` tails, the `callCounts` numbers |
| `faint` | `($spent/$limit)`, the stale `*`, `[API 429]` |
| `sep` | the ` \| ` separator **and** the empty gauge track (`░`) |
| `gradLow` | usage under 70%, **and** the `repo:` / `branch:` / `token:` values, and effort `max` |
| `gradMid` | usage 70–84%, `[API auth]` / `[API err]`, effort `high` |
| `gradHigh` | usage 85% and over, conflict counts, effort `low` |
| `add` | staged / ahead counts |
| `del` | modified / behind counts |
| `track` | untracked counts |

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
| `gradLow` | `#7fd4c4` | `#98971a` | `#94e2d5` | `#b0b0b0` | `#0a7c5a` |
| `gradMid` | `#e3c08a` | `#fabd2f` | `#f9e2af` | `#b8964f` | `#9a6d00` |
| `gradHigh` | `#e0909e` | `#fb4934` | `#f38ba8` | `#c76a6a` | `#cf222e` |
| `add` | `#8fd0b8` | `#98971a` | `#a6e3a1` | `#8fa88f` | `#116329` |
| `del` | `#e0909e` | `#fb4934` | `#f38ba8` | `#b08f8f` | `#cf222e` |
| `track` | `#8fc4d8` | `#fe8019` | `#89b4fa` | `#8f9db0` | `#8250df` |

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
- **Colors only.** Glyphs, the ` \| ` separator and the 70/85 thresholds are not
  part of a theme (thresholds live under `thresholds`), so a color can never
  disagree with the `COMPRESS?` text beside it.
- A value that isn't `#` plus exactly 6 hex digits keeps the inherited color
  rather than breaking the line. Run with `HUD_DEBUG=1` to see what was rejected
  and why.

## Behind a proxy
```sh
export HTTPS_PROXY=http://proxy.example.com:8080
# with credentials (percent-encode reserved characters in the password):
export HTTPS_PROXY=http://alice:p%40ss@proxy.example.com:8080
```
The launcher tunnels the HUD's HTTPS calls through it automatically. `https://`
proxies are supported too. A proxy that refuses the tunnel (407/403) or never
answers (10 s bound) just leaves the rate-limit fragment on the payload's own
numbers — or `[API err]` on a Claude Code too old to send them.

## Update
```sh
git -C ~/.claude/hud pull
```

## Notes
- The working-folder path shows `~` in place of `$HOME` to stay compact.
- `repo:` / `branch:` / working-tree counts cover **git and Subversion**. In an
  SVN checkout the branch comes from the URL convention (`trunk`,
  `branches/<name>`, `tags/<name>`) and carries the working-copy revision, e.g.
  `branch:2.1@12345`. Both `svn` calls are local — nothing contacts the server,
  which is why SVN shows no `⇡`/`⇣` ahead/behind — and the working-copy scan is
  cached for 30s so a large checkout is not re-walked every frame.
- All runtime files live in a per-session subfolder of `cache/`, i.e.
  `cache/<session>/<name>.json` (the render cache, the token/call-count tally
  memos, and the context-stabilization snapshot grouped per session). Centralized under the HUD
  install dir, never inside your project; safe to delete anytime. Session folders
  idle for more than 14 days are pruned automatically.
- If a render fails, the renderer's stderr is kept as
  `cache/<session>/statusline.err` (cleared by the next successful render) —
  check it when the bar shows `[HUD] HUD error`.
- Optional env: `HUD_CONFIG` (path to the config file; default is the HUD
  install's own `config.json`), `HUD_THEME` (any bundled or user theme name, overrides
  `config.json`), `HUD_CACHE_DIR` (override that cache/state dir; default is the
  HUD install's own `cache/`), `HUD_CACHE_MAX_AGE_DAYS` (idle-session retention,
  default 14), `HUD_LOCK_STALE_SECONDS` (age after which another frame may
  take over a render lock, default 10), `HUD_SYNC_REFRESH=1` (testing only:
  bypass the render cache and render this payload synchronously; set globally
  it would cost every frame a full Node render), `HUD_DEBUG=1` (verbose).
