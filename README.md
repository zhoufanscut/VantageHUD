# claude-statusline

A self-contained [Claude Code](https://claude.com/claude-code) statusline (HUD).
It renders the working folder, model, context %, rate limits, git info, session
time, and more, from the JSON that Claude Code pipes to the `statusLine` command.

- **No dependencies.** Pure Node built-ins — no `node_modules`, no native code.
- **Portable.** Clone anywhere, on macOS or Linux, with any Node `>=14`.
- **Proxy aware.** Honors `HTTPS_PROXY` / `https_proxy` for the usage/rate-limit
  API via an HTTP CONNECT tunnel (no-op when unset).

## Layout

```
statusline.sh     # entry point Claude Code calls (caches + renders)
statusline.mjs    # Node launcher: installs the proxy tunnel, loads src/
find-node.sh      # locates node (PATH / nvm / fnm / homebrew)
src/              # the renderer (ESM, Node built-ins only)
cache/            # per-session render cache (gitignored)
```

## Install on a new machine

1. Have Node installed (`node --version`, any `>=14`).
2. Clone this folder anywhere, e.g.:
   ```sh
   git clone <your-repo-url> ~/.claude/hud
   ```
3. Point Claude Code's statusline at it. In `~/.claude/settings.json`:
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "sh ~/.claude/hud/statusline.sh ~/.claude/hud/statusline.mjs"
     }
   }
   ```
   If you cloned elsewhere, use that absolute path instead. `$CLAUDE_CONFIG_DIR`
   is honored if set.
4. Start (or restart) Claude Code — the bar renders from the first frame.

## Behind a proxy

```sh
export HTTPS_PROXY=http://proxy.example.com:8080
```
The launcher tunnels the HUD's HTTPS calls through it automatically.

## Quick test

```sh
echo '{"session_id":"t","cwd":"'"$HOME"'/example","model":{"id":"claude-opus-4-8","display_name":"Opus 4.8"}}' \
  | HUD_SYNC_REFRESH=1 sh statusline.sh statusline.mjs
```

## Notes

- The working-folder path shows `~` in place of `$HOME` to stay compact.
- Per-session render cache lives in `cache/` and is safe to delete anytime.
- Optional env: `HUD_CACHE_DIR`, `HUD_SYNC_REFRESH=1` (synchronous render),
  `HUD_DEBUG=1` (verbose), `HUD_STATE_DIR` (centralized per-project state).
