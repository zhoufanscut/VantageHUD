# claude-statusline

A self-contained [Claude Code](https://claude.com/claude-code) statusline (HUD).
From the JSON Claude Code pipes to the `statusLine` command it renders the
working folder, the model with thinking effort (`opus 4.8 max`), context %,
rate limits, git info, session time, and more.

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
Expected: a single line containing `opus 4.8 high` (the leading
path is your working directory).

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
- All runtime files live in a per-session subfolder of `cache/`, i.e.
  `cache/<session>/<name>.json` (the render cache, HUD state, and the
  context-stabilization snapshot grouped per session). Centralized under the HUD
  install dir, never inside your project; safe to delete anytime.
- Optional env: `HUD_CACHE_DIR` (override that cache/state dir; default is the HUD
  install's own `cache/`), `HUD_SYNC_REFRESH=1` (synchronous render), `HUD_DEBUG=1`
  (verbose).
