#!/bin/sh
# Node.js finder (find-node.sh)
#
# Locates the Node.js binary and executes it with the provided arguments.
# Designed for nvm/fnm setups where `node` is not on PATH in non-interactive
# shells (e.g. when Claude Code invokes the statusLine command).
#
# Priority:
#   1. `which node` (node is on PATH)
#   2. nvm versioned paths  (~/.nvm/versions/node/*/bin/node)
#   3. fnm versioned paths  (~/.fnm/node-versions/*/installation/bin/node)
#   4. Homebrew / system paths (/opt/homebrew/bin/node, /usr/local/bin/node)
#
# Exits 0 on failure so it never blocks Claude Code.

NODE_BIN=""

# 1. which node
_resolved=$(command -v node 2>/dev/null)
if [ -n "$_resolved" ]; then
  NODE_BIN="$_resolved"
fi

# 2. nvm versioned paths: iterate to find the latest installed version
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  for _path in "$HOME/.nvm/versions/node/"*/bin/node; do
    [ -x "$_path" ] && NODE_BIN="$_path"
  done
fi

# 3. fnm versioned paths (Linux and macOS default locations)
if [ -z "$NODE_BIN" ]; then
  for _fnm_base in \
    "$HOME/.fnm/node-versions" \
    "$HOME/Library/Application Support/fnm/node-versions" \
    "$HOME/.local/share/fnm/node-versions"; do
    if [ -d "$_fnm_base" ]; then
      for _path in "$_fnm_base/"*/installation/bin/node; do
        [ -x "$_path" ] && NODE_BIN="$_path"
      done
      [ -n "$NODE_BIN" ] && break
    fi
  done
fi

# 4. Common Homebrew / system paths
if [ -z "$NODE_BIN" ]; then
  for _path in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$_path" ]; then
      NODE_BIN="$_path"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  printf '[HUD] Error: could not find a node binary on PATH or in nvm/fnm/homebrew.\n' >&2
  exit 0
fi

exec "$NODE_BIN" "$@"
