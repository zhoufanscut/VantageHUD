# claude-statusline

A small, self-contained [Claude Code](https://claude.com/claude-code) statusline
(HUD). From the JSON Claude Code pipes to the `statusLine` command it renders the
working folder, the model with thinking effort (`opus:max`), context %,
rate limits, git (or Subversion) info, session time, and more.

- **No dependencies.** Pure Node built-ins — no `node_modules`, no native code.
- **Portable.** Clone anywhere, on macOS or Linux, with any Node `>=14.17`.
- **Proxy aware.** Honors `HTTPS_PROXY` / `https_proxy` for the usage/rate-limit
  API via an HTTP CONNECT tunnel (no-op when unset).

## Layout

```
statusline.sh     # entry point Claude Code calls (caches + renders)
statusline.mjs    # Node launcher: installs the proxy tunnel, loads src/
find-node.sh      # locates node (PATH / nvm / fnm / homebrew)
src/              # the renderer (ESM, Node built-ins only)
cache/            # render cache + state, one subfolder per session (gitignored)
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
- Common knobs: `theme` (`aurora` | `ember`), `locale` (`en` | `zh-CN`), and the
  `elements` toggles (e.g. `gitBranch`, `contextBar`, `rateLimits`, `showTokens`).
  See `config.json.example` for the full list.
- `modelFormat` (inside `elements`) sets how the model name reads: `short`
  (`opus`, the default), `versioned` (`opus 4.8`), or `full` (raw id,
  `claude-opus-4-8`). The `:effort` suffix is a separate `effort` toggle.
- No file needed for a quick test: `HUD_THEME=ember` overrides the theme, and
  `HUD_CONFIG=/abs/path/config.json` points the HUD at a config elsewhere.

## Behind a proxy
```sh
export HTTPS_PROXY=http://proxy.example.com:8080
```
The launcher tunnels the HUD's HTTPS calls through it automatically.

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
  `cache/<session>/<name>.json` (the render cache, HUD state, and the
  context-stabilization snapshot grouped per session). Centralized under the HUD
  install dir, never inside your project; safe to delete anytime. Session folders
  idle for more than 14 days are pruned automatically.
- If a render fails, the renderer's stderr is kept as
  `cache/<session>/statusline.err` (cleared by the next successful render) —
  check it when the bar shows `[HUD] HUD error`.
- Optional env: `HUD_CONFIG` (path to the config file; default is the HUD
  install's own `config.json`), `HUD_THEME` (`aurora` | `ember`, overrides
  `config.json`), `HUD_CACHE_DIR` (override that cache/state dir; default is the
  HUD install's own `cache/`), `HUD_CACHE_MAX_AGE_DAYS` (idle-session retention,
  default 14), `HUD_SYNC_REFRESH=1` (synchronous render), `HUD_DEBUG=1` (verbose).
