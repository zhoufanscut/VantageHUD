#!/bin/sh
# Claude statusline cached launcher.
#
# Claude Code invokes statusLine commands for every render. Starting Node and
# importing the HUD bundle each time can take hundreds of milliseconds, which
# makes the first frame blank/flickery. This POSIX wrapper keeps the statusLine
# protocol unchanged (stdin JSON in, one line out) while making the hot path a
# shell read + cat of the last rendered line. A single background Node refresh
# updates the session-scoped cache for the next frame.

# Everything the wrapper creates is private, like the Node layer's 0600 writes:
# stdin.json is the whole payload (cwd, session name, transcript path, cost).
umask 077

# HUD_DEBUG=1: say which branch each frame took, on stderr (the background
# refresh has none). A no-op otherwise, and always status 0.
dbg() {
  [ -z "${HUD_DEBUG:-}" ] || printf '[HUD sh] %s\n' "$*" >&2
}

case "$0" in
  */*) SCRIPT_DIR=${0%/*} ;;
  *) SCRIPT_DIR=. ;;
esac
# CDPATH= : with CDPATH exported, `cd` prints the directory it picked, and the
# capture would hold two lines.
SCRIPT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR" >/dev/null 2>&1 && pwd -P) || SCRIPT_DIR=.
HUD_SCRIPT=${1:-"$SCRIPT_DIR/statusline.mjs"}
# User config path, mirroring Node's getHudConfigFile(): HUD_CONFIG override
# else <install>/config.json. Used to invalidate the render cache when the
# config changes (see config_changed).
HUD_CONFIG_FILE=${HUD_CONFIG:-"$SCRIPT_DIR/config.json"}
# A lock whose owner is gone may be taken over after this many seconds; one
# whose owner is still running, only after LOCK_MAX_SECONDS (a hung render, or
# a PID the OS has since recycled). See lock_is_stale.
LOCK_STALE_SECONDS=${HUD_LOCK_STALE_SECONDS:-10}
LOCK_MAX_SECONDS=120
# The PID written into a lock this process takes. The background refresh
# replaces it with its own: in a `( ... ) &` subshell `$$` is still the parent,
# which exits at once and would make the lock look abandoned.
SELF_PID=$$
LOCK_OWNER=
HOUSEKEEPING_DONE=
# Marks a cache dir as the HUD's own. Every sweep below deletes files by name
# pattern or age, so none runs in a directory without it: HUD_CACHE_DIR may
# point at a shared folder (~/.cache, $HOME, /tmp) whose other contents are not
# ours to prune.
CACHE_MARKER_NAME=.vantagehud-cache

# find-node.sh locates node for nvm/fnm installs that are off the hook's PATH.
# It is run with `sh`, so it has to exist, not to be executable: an install
# unpacked without file modes must not fall back to a bare `node`.
if [ -f "$SCRIPT_DIR/find-node.sh" ]; then
  FIND_NODE="$SCRIPT_DIR/find-node.sh"
else
  FIND_NODE=
fi

# Last resort when no cache dir is usable (a read-only install with no
# writable fallback): render this payload, read from stdin, synchronously with
# nothing cached. Node degrades without its cache, which beats
# "[HUD] Starting..." on every frame.
render_uncached() {
  dbg "no writable cache dir; rendering without the cache"
  uncached_line=$(
    HUD_SYNC_RENDER=1
    HUD_USAGE_BUDGET_MS=${HUD_SYNC_USAGE_BUDGET_MS:-1000}
    export HUD_SYNC_RENDER HUD_USAGE_BUDGET_MS
    if [ -n "$FIND_NODE" ]; then
      sh "$FIND_NODE" "$HUD_SCRIPT" 2>/dev/null
    else
      node "$HUD_SCRIPT" 2>/dev/null
    fi
  )
  if [ -n "$uncached_line" ]; then
    printf '%s\n' "$uncached_line"
  else
    printf '[HUD] Starting...\n'
  fi
  exit 0
}

# Use $1 as the cache dir if it is, or can be made, a writable directory. Sets
# CACHE_DIR to its physical path, and CACHE_CREATED when this call made it.
use_cache_dir() {
  CACHE_CREATED=
  if [ ! -d "$1" ]; then
    mkdir -p "$1" 2>/dev/null || return 1
    CACHE_CREATED=1
  fi
  [ -w "$1" ] || return 1
  CACHE_DIR=$(CDPATH= cd -- "$1" >/dev/null 2>&1 && pwd -P)
}

# HUD_CACHE_DIR, else the install's own cache/. When that default is not
# writable (a read-only or shared install), the user's cache dir instead —
# exported, so Node keeps its state in the same place.
if use_cache_dir "${HUD_CACHE_DIR:-"$SCRIPT_DIR/cache"}"; then
  :
elif [ -z "${HUD_CACHE_DIR:-}" ] && [ -n "${HOME:-}" ] \
  && use_cache_dir "${XDG_CACHE_HOME:-"$HOME/.cache"}/vantagehud"; then
  dbg "install cache not writable; using $CACHE_DIR"
  HUD_CACHE_DIR=$CACHE_DIR
  export HUD_CACHE_DIR
else
  render_uncached
fi
CACHE_MARKER="$CACHE_DIR/$CACHE_MARKER_NAME"
# Mark the dir when the wrapper just created it, and always the install's own
# cache/ — which also adopts the cache of an install that predates the marker.
# A HUD_CACHE_DIR that already existed is never adopted: the sweeps skip it
# until the user creates the marker there.
if [ ! -f "$CACHE_MARKER" ] \
  && { [ -n "$CACHE_CREATED" ] || [ "$CACHE_DIR" = "$SCRIPT_DIR/cache" ]; }; then
  : > "$CACHE_MARKER" 2>/dev/null || :
fi
INPUT_TMP="$CACHE_DIR/stdin.$$.tmp"

# Sets FILE_MTIME to $1's mtime in epoch seconds; fails when unreadable. GNU
# and busybox stat take -c, BSD/macOS stat -f. The numeric check matters: when
# the file vanishes between the two calls, GNU `stat -f` (filesystem status)
# prints a "File: ..." report, and arithmetic on that aborts the whole script.
file_mtime() {
  FILE_MTIME=$(stat -c %Y "$1" 2>/dev/null) || FILE_MTIME=$(stat -f %m "$1" 2>/dev/null) || FILE_MTIME=
  case $FILE_MTIME in
    '' | *[!0-9]*) FILE_MTIME=; return 1 ;;
  esac
}

# Sets AGE to the seconds since $1 was last modified; fails when unreadable.
path_age() {
  file_mtime "$1" || return 1
  AGE=$(date +%s 2>/dev/null) || return 1
  case $AGE in
    '' | *[!0-9]*) return 1 ;;
  esac
  AGE=$((AGE - FILE_MTIME))
}

# Sets CFG_STAMP to the config's mtime:size:inode, empty when there is no
# config; fails when it exists but cannot be stat'ed. Compared for *inequality*
# with the stamp recorded when the cached line was rendered, so a config dated
# in the future (clock skew, a copy that kept its times) cannot force a render
# on every frame, and an edit in the same second as that render still shows
# unless it kept both the size and the inode.
config_stamp() {
  CFG_STAMP=
  [ -f "$HUD_CONFIG_FILE" ] || return 0
  CFG_STAMP=$(stat -c '%Y:%s:%i' "$HUD_CONFIG_FILE" 2>/dev/null) \
    || CFG_STAMP=$(stat -f '%m:%z:%i' "$HUD_CONFIG_FILE" 2>/dev/null) || CFG_STAMP=
  case $CFG_STAMP in
    '' | *[!0-9:]*) CFG_STAMP=; return 1 ;;
  esac
}

# True when the config differs from the one the cached line was rendered with.
# An unreadable config never forces a re-render.
config_changed() {
  config_stamp || return 1
  recorded_stamp=
  [ ! -f "$CONFIG_STAMP_FILE" ] || read -r recorded_stamp 2>/dev/null < "$CONFIG_STAMP_FILE" || :
  [ "$CFG_STAMP" != "$recorded_stamp" ]
}

# True once a time trigger that the cached line predates has passed: Claude
# Code re-runs the command when a rate-limit window reaches `resets_at` and
# when a warm prompt cache reaches `expires_at`, and serving the previous frame
# then wastes the trigger — an idle session has no next one. Node sets the
# deadline file's *mtime* to the earliest such moment (less a second), and
# stdin.json was written by this very frame, so its mtime is "now" and the test
# costs no fork. `-ot` is not POSIX, but dash, bash, busybox and macOS sh all
# have it; a shell without it fails the test and keeps the old one-frame lag.
deadline_passed() {
  [ -f "$DEADLINE_FILE" ] && [ "$DEADLINE_FILE" -ot "$INPUT_FILE" ]
}

# Orphans of a wrapper that died mid-render (killed, or a failed fork). A
# stdin/statusline .tmp goes whatever its size: a killed render leaves a
# complete line in it that nothing will ever promote. So does a Node
# atomic-write temp (`.<name>.tmp.<token>`, renamed into place milliseconds
# after it is opened). A .err is kept while non-empty — it is the only record
# of why that render died. One `find`, not a per-file loop costing ~6 forks a
# file: forks are exactly what is scarce when orphans pile up (a Windows/Git
# Bash run sweeping ~35 of them during a fork storm took 2m15s for the whole
# wrapper). -mmin +1 (GNU and busybox find truncate the age, so two minutes or
# more in effect) is far past any live render, and one that did outlive it has
# already written its line itself (HUD_OUTPUT_FILE). Runs from the background
# refresh, never the hot path, like the two sweeps below.
cleanup_stale_temp_files() {
  find "$CACHE_DIR" -maxdepth 2 -type f -mmin +1 \
    \( -name 'stdin.*.tmp' -o -name 'statusline.*.tmp' -o -name '.*.tmp.*' \
    -o \( -name 'statusline.*.err' -size 0 \) \) \
    -exec rm -f {} + 2>/dev/null || :
}

# Sets LOCK_PID to the owner recorded in lock dir $1; empty when there is none
# (a lock from an older wrapper, or one whose owner has not written it yet).
lock_owner() {
  LOCK_PID=
  [ ! -f "$1/pid" ] || read -r LOCK_PID 2>/dev/null < "$1/pid" || :
  case $LOCK_PID in
    *[!0-9]*) LOCK_PID= ;;
  esac
}

# A render lock is stale when it is older than LOCK_STALE_SECONDS and its owner
# is no longer running, or older than LOCK_MAX_SECONDS whoever owns it. Age
# alone is not enough: an unbudgeted background render can outlive 10 s (a
# proxy that never answers holds it ~10 s), and taking its lock over started a
# second render — and let the older one land last, over the newer line.
lock_is_stale() {
  path_age "$1" || return 1
  [ "$AGE" -gt "$LOCK_STALE_SECONDS" ] || return 1
  [ "$AGE" -le "$LOCK_MAX_SECONDS" ] || return 0
  lock_owner "$1"
  [ -z "$LOCK_PID" ] || ! kill -0 "$LOCK_PID" 2>/dev/null
}

# Remove lock dir $1 if it is stale. Serialized through a sibling `.reap` dir
# (mkdir is atomic) and re-checked under it: two wrappers that both judged the
# lock stale would otherwise each remove it — the second deleting the fresh lock
# the first had just taken — and both render. A reaper holds `.reap` for a few
# milliseconds; one left behind by a killed reaper is cleared once it is older
# than LOCK_STALE_SECONDS.
reap_lock() {
  lock_is_stale "$1" || return 1
  if ! mkdir "$1.reap" 2>/dev/null; then
    if path_age "$1.reap" && [ "$AGE" -gt "$LOCK_STALE_SECONDS" ]; then
      rmdir "$1.reap" 2>/dev/null || :
    fi
    return 1
  fi
  reaped=1
  if lock_is_stale "$1"; then
    rm -rf "$1" 2>/dev/null && reaped=0
  fi
  rmdir "$1.reap" 2>/dev/null || :
  return "$reaped"
}

# Record SELF_PID as the owner of the lock this process now holds.
claim_lock() {
  LOCK_OWNER=$SELF_PID
  printf '%s\n' "$SELF_PID" > "$LOCK_DIR/pid" 2>/dev/null || :
}

# Release the render lock, but only while it is still ours: one taken over past
# LOCK_MAX_SECONDS belongs to another render by now.
release_lock() {
  [ -n "$LOCK_OWNER" ] || return 0
  lock_owner "$LOCK_DIR"
  if [ "$LOCK_PID" = "$LOCK_OWNER" ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || :
  fi
  LOCK_OWNER=
}

# Other sessions' abandoned locks; this session's own is handled by
# try_acquire_lock.
cleanup_stale_render_locks() {
  for stale_lock_dir in "$CACHE_DIR"/*/render.lock; do
    [ -d "$stale_lock_dir" ] || continue
    reap_lock "$stale_lock_dir" || :
  done
}

PRUNE_MARKER="$CACHE_DIR/.last-prune"
PRUNE_INTERVAL_SECONDS=86400
CACHE_MAX_AGE_DAYS=${HUD_CACHE_MAX_AGE_DAYS:-14}

# Evict abandoned cache state. Runs from the background refresh (never the hot
# path) and at most once per PRUNE_INTERVAL_SECONDS via the marker file.
prune_old_cache() {
  if [ -f "$PRUNE_MARKER" ] && path_age "$PRUNE_MARKER" \
    && [ "$AGE" -lt "$PRUNE_INTERVAL_SECONDS" ]; then
    return
  fi
  touch "$PRUNE_MARKER" 2>/dev/null || :
  # Legacy flat files from the pre-subfolder layout (<name>.<session>.json at
  # the cache root) — dead since sessions moved into subfolders; remove.
  find "$CACHE_DIR" -maxdepth 1 -type f \
    \( -name 'hud-state.*.json' -o -name 'hud-stdin-cache.*.json' \
    -o -name 'stdin.*.json' -o -name 'statusline.*.txt' \
    -o -name 'compact-requested.*.json' \) \
    -exec rm -f {} + 2>/dev/null || :
  # Session folders idle longer than the retention window (GNU and busybox
  # find truncate the age to whole days, so one day more in effect; BSD find
  # rounds up). A folder's mtime refreshes on every render (files are renamed
  # into it), so live sessions are never this old; a wrongly-pruned idle
  # session self-heals via the synchronous first-render path.
  find "$CACHE_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$CACHE_MAX_AGE_DAYS" \
    -exec rm -rf {} + 2>/dev/null || :
}

# Every sweep, gated on the cache marker (see CACHE_MARKER_NAME).
housekeeping() {
  if [ ! -f "$CACHE_MARKER" ]; then
    dbg "no $CACHE_MARKER_NAME in $CACHE_DIR; skipping the cache sweeps"
    return
  fi
  cleanup_stale_temp_files
  cleanup_stale_render_locks
  prune_old_cache
}

# Capture Claude's current statusLine stdin first so rendered output can be
# scoped per session/worktree instead of leaking across concurrent sessions.
# A redirect that fails never starts `cat`, so stdin is still unread for Node.
if ! cat 2>/dev/null > "$INPUT_TMP"; then
  rm -f "$INPUT_TMP" 2>/dev/null || :
  render_uncached
fi

# The first "key":"value" string in the payload. `t` branches to the
# print-and-quit only on a line where the substitution matched, which keeps
# the semantics of `sed -n 's///p' | head -1` in one process instead of two.
extract_json_string() {
  sed -n -e "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/" \
    -e 't found' -e d -e ':found' -e p -e q "$INPUT_TMP" 2>/dev/null
}

SESSION_KEY=$(extract_json_string session_id)
if [ -z "$SESSION_KEY" ] && [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  SESSION_KEY=$CLAUDE_CODE_SESSION_ID
fi
if [ -z "$SESSION_KEY" ] && [ -n "${CLAUDE_SESSION_ID:-}" ]; then
  SESSION_KEY=$CLAUDE_SESSION_ID
fi
if [ -z "$SESSION_KEY" ] && [ -n "${CLAUDECODE_SESSION_ID:-}" ]; then
  SESSION_KEY=$CLAUDECODE_SESSION_ID
fi
if [ -z "$SESSION_KEY" ]; then
  TRANSCRIPT_PATH=$(extract_json_string transcript_path)
  if [ -n "$TRANSCRIPT_PATH" ]; then
    SESSION_KEY=$(printf '%s\n' "$TRANSCRIPT_PATH" | sed -n 's/.*\([0-9a-fA-F][0-9a-fA-F-]\{35\}\).*/\1/p' | head -1)
    if [ -z "$SESSION_KEY" ]; then
      SESSION_KEY=$(printf '%s\n' "$TRANSCRIPT_PATH" | cksum 2>/dev/null | awk '{print "transcript-" $1}')
    fi
  fi
fi
if [ -z "$SESSION_KEY" ]; then
  CWD_VALUE=$(extract_json_string cwd)
  if [ -n "$CWD_VALUE" ]; then
    SESSION_KEY=$(printf '%s\n' "$CWD_VALUE" | cksum 2>/dev/null | awk '{print "cwd-" $1}')
  fi
fi
if [ -z "$SESSION_KEY" ]; then
  SESSION_KEY=default
fi
# Only a key with an unsafe byte pays for the sanitizing fork (a UUID never
# does). tr, not a line-based sed, so a newline maps to `_` like every other
# byte — Node re-sanitizes HUD_SESSION_KEY and would otherwise name another
# folder.
case $SESSION_KEY in
  *[!A-Za-z0-9_.-]*) SESSION_KEY=$(printf '%s' "$SESSION_KEY" | tr -c 'A-Za-z0-9_.-' '_') ;;
esac
# A bare . or .. would point the session dir at the cache root or its parent.
case "$SESSION_KEY" in
  . | ..) SESSION_KEY=default ;;
esac

# Every file for a session lives together in its own subfolder. If it can't be
# created, render without the cache rather than stranding the payload.
SESSION_DIR="$CACHE_DIR/$SESSION_KEY"
if [ ! -d "$SESSION_DIR" ] && ! mkdir -p "$SESSION_DIR" 2>/dev/null; then
  exec < "$INPUT_TMP"
  rm -f "$INPUT_TMP" 2>/dev/null || :
  render_uncached
fi

INPUT_FILE="$SESSION_DIR/stdin.json"
OUTPUT_FILE="$SESSION_DIR/statusline.txt"
LOCK_DIR="$SESSION_DIR/render.lock"
# The config stamp the cached line was rendered with (config_changed).
CONFIG_STAMP_FILE="$SESSION_DIR/config.stamp"
# Written by Node; its mtime is the next time trigger (deadline_passed).
DEADLINE_FILE="$SESSION_DIR/statusline.deadline"
# Set when a payload arrived while a render held the lock, so that render runs
# once more (acquire_or_flag, background_refresh).
DIRTY_FILE="$SESSION_DIR/render.dirty"
NODE_STDOUT_TMP="$SESSION_DIR/statusline.$$.tmp"
NODE_STDERR_TMP="$SESSION_DIR/statusline.$$.err"
SYNC_RENDER=
USAGE_BUDGET_MS=
# At most this many renders per background refresh: the first, then one per
# payload that arrived while it held the lock.
REFRESH_MAX_PASSES=3

if [ -s "$INPUT_TMP" ]; then
  mv "$INPUT_TMP" "$INPUT_FILE" 2>/dev/null || cp "$INPUT_TMP" "$INPUT_FILE" 2>/dev/null || :
fi
[ ! -e "$INPUT_TMP" ] || rm -f "$INPUT_TMP" 2>/dev/null || :

try_acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    claim_lock
    return 0
  fi
  [ -d "$LOCK_DIR" ] || return 1
  reap_lock "$LOCK_DIR" || return 1
  dbg "took over a stale render lock"
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  claim_lock
}

# Take the lock, or leave this frame's payload to the render holding it. The
# holder checks the dirty flag *after* releasing and this side retries *after*
# setting it, so the payload cannot fall between the two: either the holder
# sees the flag, or it released before the retry.
acquire_or_flag() {
  try_acquire_lock && return 0
  : > "$DIRTY_FILE" 2>/dev/null || :
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    claim_lock
    return 0
  fi
  dbg "render lock busy; the payload is left to its holder"
  return 1
}

refresh_cache() {
  cleanup_refresh_artifacts() {
    rm -f "$NODE_STDOUT_TMP" 2>/dev/null || :
    if [ ! -s "$NODE_STDERR_TMP" ]; then
      rm -f "$NODE_STDERR_TMP" 2>/dev/null || :
    fi
    release_lock
  }

  trap 'cleanup_refresh_artifacts' EXIT
  trap 'cleanup_refresh_artifacts; exit 0' HUP INT TERM

  if [ ! -s "$INPUT_FILE" ]; then
    cleanup_refresh_artifacts
    trap - EXIT HUP INT TERM
    return
  fi

  # Cleared before Node reads stdin.json: a flag set from here on marks a
  # payload this render may not have seen.
  [ ! -f "$DIRTY_FILE" ] || rm -f "$DIRTY_FILE" 2>/dev/null || :
  # Taken before Node reads the config, so an edit made while it renders is
  # not recorded as already shown.
  config_stamp || CFG_STAMP=

  # HUD_SESSION_KEY hands Node the exact key that named this session folder, so
  # the renderer's cache files land in the same folder even when the key came
  # from a fallback (transcript/cwd checksum) Node cannot recompute itself.
  # HUD_OUTPUT_FILE lets Node write the cached line itself as soon as it has
  # one, so a wrapper killed before its own mv below still leaves it behind;
  # HUD_DEADLINE_FILE is where it records the next time trigger.
  # HUD_SYNC_RENDER / HUD_USAGE_BUDGET_MS are set by the caller for a
  # synchronous render only: Node then skips the `svn status` walk and caps
  # its wait on the usage API.
  if [ -n "$FIND_NODE" ]; then
    HUD_SESSION_KEY="$SESSION_KEY" HUD_OUTPUT_FILE="$OUTPUT_FILE" \
      HUD_DEADLINE_FILE="$DEADLINE_FILE" \
      HUD_SYNC_RENDER="$SYNC_RENDER" HUD_USAGE_BUDGET_MS="$USAGE_BUDGET_MS" \
      sh "$FIND_NODE" "$HUD_SCRIPT" < "$INPUT_FILE" > "$NODE_STDOUT_TMP" 2> "$NODE_STDERR_TMP"
  else
    HUD_SESSION_KEY="$SESSION_KEY" HUD_OUTPUT_FILE="$OUTPUT_FILE" \
      HUD_DEADLINE_FILE="$DEADLINE_FILE" \
      HUD_SYNC_RENDER="$SYNC_RENDER" HUD_USAGE_BUDGET_MS="$USAGE_BUDGET_MS" \
      node "$HUD_SCRIPT" < "$INPUT_FILE" > "$NODE_STDOUT_TMP" 2> "$NODE_STDERR_TMP"
  fi

  # A failed render either leaves stdout empty (crash, timeout, no node) or
  # prints a "[HUD] ..." fallback line (a caught runtime error). Empty output
  # keeps the last good line; the fallback line replaces it on purpose, since
  # it points at stderr — kept as statusline.err on failure and cleared only by
  # a successful render. Successful renders may emit benign stderr noise
  # (worktree warnings, HUD_DEBUG) — that is never persisted; under HUD_DEBUG
  # it is passed on to this wrapper's stderr.
  if [ ! -s "$NODE_STDOUT_TMP" ] || grep -q '^\[HUD\]' "$NODE_STDOUT_TMP" 2>/dev/null; then
    dbg "render failed; its stderr is in $SESSION_DIR/statusline.err"
    if [ -s "$NODE_STDERR_TMP" ]; then
      mv "$NODE_STDERR_TMP" "$SESSION_DIR/statusline.err" 2>/dev/null || :
    fi
  else
    if [ -n "${HUD_DEBUG:-}" ] && [ -s "$NODE_STDERR_TMP" ]; then
      cat "$NODE_STDERR_TMP" >&2 2>/dev/null || :
    fi
    rm -f "$SESSION_DIR/statusline.err" 2>/dev/null || :
  fi
  if [ -s "$NODE_STDOUT_TMP" ]; then
    mv "$NODE_STDOUT_TMP" "$OUTPUT_FILE" 2>/dev/null || cp "$NODE_STDOUT_TMP" "$OUTPUT_FILE" 2>/dev/null || :
    printf '%s\n' "$CFG_STAMP" > "$CONFIG_STAMP_FILE" 2>/dev/null || :
  fi

  # Never while Claude Code waits on a synchronous render: the next background
  # refresh does it.
  if [ -z "$SYNC_RENDER" ] && [ -z "$HOUSEKEEPING_DONE" ]; then
    HOUSEKEEPING_DONE=1
    housekeeping
  fi

  rm -f "$NODE_STDOUT_TMP" "$NODE_STDERR_TMP" 2>/dev/null || :
  release_lock
  trap - EXIT HUP INT TERM
}

# The background refresh: render, then again while payloads arrived during the
# previous render (acquire_or_flag), up to REFRESH_MAX_PASSES renders — so a
# burst of triggers ends on its last payload, not its first. Runs in a
# `( ... ) &` subshell, holding the lock its parent took.
background_refresh() {
  # Unbudgeted, even when a synchronous render spawned it.
  SYNC_RENDER=
  USAGE_BUDGET_MS=
  SELF_PID=$(sh -c 'echo "$PPID"' 2>/dev/null) || SELF_PID=
  case $SELF_PID in
    '' | *[!0-9]*) SELF_PID=$$ ;;
  esac
  claim_lock
  refresh_passes=0
  while :; do
    refresh_cache
    refresh_passes=$((refresh_passes + 1))
    [ "$refresh_passes" -lt "$REFRESH_MAX_PASSES" ] || break
    [ -f "$DIRTY_FILE" ] || break
    try_acquire_lock || break
  done
}

# Hot path: return immediately from the last successful render for this session
# — unless config.json changed since that render (fall through to a synchronous
# refresh so the edit shows on this frame, not the next), a time trigger the
# cached line predates has passed (deadline_passed), or HUD_SYNC_REFRESH=1 asks
# for this payload to be rendered before anything is printed. The smoke test
# relies on the latter: served from the cache, it would print the *previous*
# frame and a code change would look like it had no effect.
if [ "${HUD_SYNC_REFRESH:-0}" = "1" ]; then
  dbg "HUD_SYNC_REFRESH=1: synchronous render"
elif [ ! -s "$OUTPUT_FILE" ]; then
  dbg "no cached line: synchronous render"
elif config_changed; then
  dbg "config changed since the cached line: synchronous render"
elif deadline_passed; then
  dbg "a time trigger passed since the cached line: synchronous render"
else
  dbg "hot path: cached line served"
  cat "$OUTPUT_FILE" 2>/dev/null || printf '[HUD] Starting...\n'
  # Refresh in background for the next frame.
  if acquire_or_flag; then
    ( background_refresh ) >/dev/null 2>&1 &
  fi
  exit 0
fi

# Synchronous refresh: the first render for this session, a config.json change
# since the last render, a passed time trigger, or HUD_SYNC_REFRESH=1. Claude
# Code re-runs the statusLine command only on its own triggers (new assistant
# message, /compact, a permission-mode or vim toggle, a configured
# refreshInterval, a rate-limit reset, a prompt-cache expiry), so an async
# background refresh can leave the pane stuck on the old frame (or
# "[HUD] Starting...") for a long time.
# Claude Code is waiting on this render, so Node skips its slow work: the
# usage API gets a budget (cached numbers past it) and `svn status` is served
# from its memo. The background refreshes above run in full and keep both
# caches fresh.
if [ -s "$INPUT_FILE" ] && acquire_or_flag; then
  # Node writes the next deadline, or none. Dropping the passed one first
  # means a render that fails cannot make every later frame synchronous.
  [ ! -f "$DEADLINE_FILE" ] || rm -f "$DEADLINE_FILE" 2>/dev/null || :
  SYNC_RENDER=1
  USAGE_BUDGET_MS=${HUD_SYNC_USAGE_BUDGET_MS:-1000}
  refresh_cache
  if [ -s "$OUTPUT_FILE" ] && cat "$OUTPUT_FILE" 2>/dev/null; then
    # A payload that arrived during this render gets a background one.
    if [ -f "$DIRTY_FILE" ] && try_acquire_lock; then
      ( background_refresh ) >/dev/null 2>&1 &
    fi
    exit 0
  fi
fi

# Synchronous refresh was unavailable (lock held or render failed). Prefer the
# last good line — even if it predates a config edit — over the placeholder, so
# an existing HUD never flashes back to "[HUD] Starting...".
if [ -s "$OUTPUT_FILE" ]; then
  dbg "serving the cached line"
  cat "$OUTPUT_FILE" 2>/dev/null && exit 0
fi

dbg "no cached line yet; serving the placeholder"
printf '[HUD] Starting...\n'
exit 0
