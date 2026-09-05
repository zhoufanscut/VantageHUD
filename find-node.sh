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

# Pick the highest-versioned executable among candidate paths (one per line on
# stdin) whose path carries a vX.Y.Z segment. Glob order is lexical — v9 sorts
# after v20 — so the version is compared numerically via a zero-padded key.
newest_node() {
  while IFS= read -r _cand; do
    [ -x "$_cand" ] || continue
    _key=$(printf '%s\n' "$_cand" | sed -n 's/.*\/v\{0,1\}\([0-9]\{1,\}\)\.\([0-9]\{1,\}\)\.\([0-9]\{1,\}\)\/.*/\1 \2 \3/p')
    [ -n "$_key" ] || continue
    set -- $_key
    printf '%08d%08d%08d %s\n' "$1" "$2" "$3" "$_cand"
  done | sort -r | head -1 | cut -d' ' -f2-
}

# 1. which node
_resolved=$(command -v node 2>/dev/null)
if [ -n "$_resolved" ]; then
  NODE_BIN="$_resolved"
fi

# 2. nvm versioned paths: the newest installed version
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_BIN=$(for _path in "$HOME/.nvm/versions/node/"*/bin/node; do printf '%s\n' "$_path"; done | newest_node)
fi

# 3. fnm versioned paths (Linux and macOS default locations)
if [ -z "$NODE_BIN" ]; then
  for _fnm_base in \
    "$HOME/.fnm/node-versions" \
    "$HOME/Library/Application Support/fnm/node-versions" \
    "$HOME/.local/share/fnm/node-versions"; do
    if [ -d "$_fnm_base" ]; then
      NODE_BIN=$(for _path in "$_fnm_base/"*/installation/bin/node; do printf '%s\n' "$_path"; done | newest_node)
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
