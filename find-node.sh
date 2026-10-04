#!/bin/sh
# Node.js finder (find-node.sh)
#
# Locates the Node.js binary and executes it with the provided arguments.
# Designed for nvm/fnm setups where `node` is not on PATH in non-interactive
# shells (e.g. when Claude Code invokes the statusLine command).
#
# Priority:
#   1. `which node` (node is on PATH)
#   2. nvm versioned paths  ($NVM_DIR, ${XDG_CONFIG_HOME:-~/.config}/nvm, ~/.nvm)
#   3. fnm versioned paths  ($FNM_DIR, ~/.fnm, and the per-OS data dirs)
#   4. mise / asdf installs ($MISE_DATA_DIR or ~/.local/share/mise,
#      $ASDF_DATA_DIR or ~/.asdf)
#   5. Volta, Homebrew and system paths (~/.volta/bin/node,
#      /opt/homebrew/bin/node, /usr/local/bin/node, /usr/bin/node)
#
# The *_DIR variables usually come from shell rc files and are often missing
# exactly where this script matters (a GUI-launched Claude Code), so each
# tool's default location is probed as well.
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

# newest_node over the arguments (an expanded glob).
newest_of() {
  for _path in "$@"; do printf '%s\n' "$_path"; done | newest_node
}

# 1. which node
_resolved=$(command -v node 2>/dev/null)
if [ -n "$_resolved" ]; then
  NODE_BIN="$_resolved"
fi

# 2. nvm versioned paths: the newest installed version. nvm's installer uses
#    $XDG_CONFIG_HOME/nvm when XDG_CONFIG_HOME is set, else ~/.nvm.
if [ -z "$NODE_BIN" ]; then
  for _nvm_base in "${NVM_DIR:-}" "${XDG_CONFIG_HOME:-$HOME/.config}/nvm" "$HOME/.nvm"; do
    if [ -n "$_nvm_base" ] && [ -d "$_nvm_base/versions/node" ]; then
      NODE_BIN=$(newest_of "$_nvm_base/versions/node/"*/bin/node)
      [ -n "$NODE_BIN" ] && break
    fi
  done
fi

# 3. fnm versioned paths ($FNM_DIR, then the Linux and macOS default locations)
if [ -z "$NODE_BIN" ]; then
  for _fnm_base in \
    "${FNM_DIR:+$FNM_DIR/node-versions}" \
    "$HOME/.fnm/node-versions" \
    "$HOME/Library/Application Support/fnm/node-versions" \
    "$HOME/.local/share/fnm/node-versions"; do
    if [ -n "$_fnm_base" ] && [ -d "$_fnm_base" ]; then
      NODE_BIN=$(newest_of "$_fnm_base/"*/installation/bin/node)
      [ -n "$NODE_BIN" ] && break
    fi
  done
fi

# 4. mise and asdf installs (version dirs without a leading v, e.g. 22.11.0)
if [ -z "$NODE_BIN" ]; then
  for _vm_base in \
    "${MISE_DATA_DIR:-$HOME/.local/share/mise}/installs/node" \
    "${ASDF_DATA_DIR:-$HOME/.asdf}/installs/nodejs"; do
    if [ -d "$_vm_base" ]; then
      NODE_BIN=$(newest_of "$_vm_base/"*/bin/node)
      [ -n "$NODE_BIN" ] && break
    fi
  done
fi

# 5. Volta's shim, then common Homebrew / system paths
if [ -z "$NODE_BIN" ]; then
  for _path in "${VOLTA_HOME:-$HOME/.volta}/bin/node" \
    /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$_path" ]; then
      NODE_BIN="$_path"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  printf '[HUD] Error: could not find a node binary on PATH or in nvm/fnm/mise/asdf/volta/homebrew.\n' >&2
  exit 0
fi

exec "$NODE_BIN" "$@"
