# AGENTS.md

Self-contained Claude Code statusline (HUD). Reads one JSON payload on stdin, prints the status line on stdout. Pure Node built-ins, ESM, **zero dependencies**. See `README.md` for end-user setup/proxy/env docs — this file is the agent-specific map.

**Shared vocabulary lives in [`GLOSSARY.md`](GLOSSARY.md)** — read it if a term here is unfamiliar (element, fragment, palette/token, session key, render context, safeMode, …). It also flags the easy-to-confuse pairs (`statusline` vs `statusLine`, render context vs context window). When you add an element/theme, add its term there too.

## Source of truth & build (read first)

- **The `.js` files under `src/` ARE the source. Edit them directly.** They look like transpiled TypeScript (JSDoc `@param` types, `??`, a comment in `src/hud/types.js` referencing a non-existent `render.ts`), but there is **no `tsconfig`, no `.ts` files, no build step, no `node_modules`**. Do not look for or create a build pipeline; do not introduce `.ts`.
- **No package manager install is needed or wanted.** `package.json` has no deps, no scripts. Never add a dependency or `node_modules` — the project's entire value proposition is being self-contained Node built-ins only (`"type": "module"`, `engines.node >=14.17`).
  - Caveat: `src/lib/atomic-write.js` uses `crypto.randomUUID()`, so the real floor is **Node ≥ 14.17**, not 14.0.
- Shared utilities live in **`src/lib/`** (recently moved from `src/utils/`, `src/cli/utils/`, `src/platform/`). Import helpers from `../lib/...`.

## Verification (there are no tests)

No test runner, no linter, no formatter, no typecheck, no CI. The only verification is the smoke test — **run it after any change**:

```sh
echo '{"session_id":"t","cwd":"'"$HOME"'/example","effort":{"level":"high"},"model":{"id":"claude-opus-4-8","display_name":"Opus 4.8"}}' \
  | HUD_SYNC_REFRESH=1 sh statusline.sh statusline.mjs
```

Expect one line containing `opus:high`. `HUD_SYNC_REFRESH=1` forces a synchronous render (skips the background-cache hot path); `HUD_DEBUG=1` adds stderr diagnostics. To exercise the renderer alone: `... | node statusline.mjs`.

## Execution flow (not obvious from filenames)

```
Claude Code → statusline.sh → find-node.sh → statusline.mjs → src/hud/index.js → src/hud/render.js → src/hud/elements/*.js
```

- `statusline.sh` (POSIX, no bashisms) is a **caching wrapper**, not just a launcher. Hot path = `cat` the last rendered line for this session and kick a background Node refresh for the *next* frame. First render per session is **synchronous** because Claude Code v2.1.x doesn't re-poll until user interaction. **Config edits are picked up on the next frame, not the one after:** the hot path is bypassed (forcing a synchronous re-render) whenever `config.json`'s mtime is newer than the cached `statusline.txt` — see `config_newer_than` (the config path mirrors Node's `getHudConfigFile`: `HUD_CONFIG` override else `<install>/config.json`). When that sync render can't run (lock held / render failed), the wrapper still prefers the stale cached line over the `[HUD] Starting...` placeholder. All runtime files — the shell's per-session render cache + `mkdir`-based render lock, *and* the Node HUD's state — live in a **per-session subfolder** of `cache/` (gitignored): `cache/<session>/<name>.json` (e.g. `stdin.json`, `statusline.txt`, `render.lock`, `hud-state.json`). Keep it relocatable: the cache dir is derived from the script dir (shell) / module location (Node), honors `HUD_CACHE_DIR`, and is never hardcoded.
- `find-node.sh` locates `node` for non-interactive shells (PATH → nvm → fnm → homebrew) and always `exit 0` so it never blocks Claude Code.
- `statusline.mjs` installs an `HTTPS_PROXY`/`https_proxy` CONNECT tunnel by monkey-patching `node:https` **before** dynamically importing the HUD, then `import()`s `src/hud/index.js`.
- `src/hud/index.js:main()` builds a single `context` object from stdin + transcript + HUD state + usage API, then calls `render(context, config)`.

## Configuration

- User config lives in the HUD's **own `config.json`** at the install root (next to `cache/`), resolved by `getHudConfigFile()` in **`src/lib/install-paths.js`** (default `<install>/config.json`; `HUD_CONFIG` env overrides with an absolute path). It is **gitignored** (`/config.json`); the committed **`config.json.example`** is the canonical reference and mirrors `DEFAULT_HUD_CONFIG`. The file is **optional** — absent/unreadable ⇒ code defaults. Its top-level object **IS** the config (no wrapper key). `src/hud/state.js#readHudConfig()` reads it with a plain `JSON.parse`; `src/hud/themes.js#readConfiguredTheme()` separately reads just `theme` from the same file at import. Precedence: `config.json` > defaults (theme also honors `HUD_THEME` env first).
- **Why its own file, not Claude Code's `settings.json`:** the HUD historically read a lowercase `statusline` block from `settings.json`, but that is **distinct** from the `statusLine` (capital-L) command-hook key (README). Claude Code's settings schema is a non-strict Zod object that **silently strips unknown keys** — so any non-schema config there (a lowercase `statusline` block, or anything nested inside `statusLine`) survives the HUD's own parse but gets wiped whenever Claude Code's settings tooling rewrites the file. `config.json` sidesteps that entirely. (The `statusLine` hook schema accepts only `type`, `command`, `padding`, `refreshInterval`, `hideVimModeIndicator`.)
- Defaults, labels (en + zh-CN), and the canonical element order (`DEFAULT_ELEMENT_ORDER`) all live in **`src/hud/types.js`**. Change defaults there — and keep `config.json.example` in sync.

## Adding or changing a statusline element

An element is a pure function `export function renderXxx(args) → string | null` (return `null` to render nothing; the string is a fragment with **no separators and no newlines** — `render.js` joins fragments with `" | "`). The HUD renders a **single line**, so every element is an inline fragment.

To add one, touch these files (in order):
1. `src/hud/elements/<name>.js` — the render function. Use color helpers from `src/hud/colors.js` (`paint`, `paintLabel`, `paintFaint`, `PALETTE.*`), never raw escape codes.
2. `src/hud/render.js` — import it, guard on `enabledElements.<name>`, and store the result via `rendered.set("<name>", el)`.
3. `src/hud/types.js` — add the enable flag to `DEFAULT_HUD_CONFIG.elements` and place `"<name>"` in `DEFAULT_ELEMENT_ORDER.main`.
4. `src/hud/index.js` — only if the element needs new data: extract it and add a field to the `context` object.

## Adding or changing a theme

- Palettes (the color **data**) live in **`src/hud/themes.js`** as the `THEMES` registry; **`src/hud/colors.js`** is the rendering **engine** (color-depth detection, `fg`/`paint`, gradient math) and exports the active palette as **`PALETTE`**. To add a theme, add one entry to `THEMES` with all 10 tokens (the file header documents each token's role) — **no other file changes**. Every element already routes through `PALETTE`/the `paint*` helpers.
- Active theme is resolved **at import** in `themes.js#resolveThemeName`: `HUD_THEME` env > `config.json` `theme` > `DEFAULT_THEME` (`aurora`). It must be import-time, not render-time, because elements freeze `fg(PALETTE.x)` into module-level constants before `main()` reads the runtime config. `HUD_THEME=<name>` is the quick way to A/B a render.
- Built-in themes: `aurora` (cool slate, the original — current default) and `ember` (warm gruvbox). `DEFAULT_THEME` lives in `themes.js`; the documented config default also lives in `DEFAULT_HUD_CONFIG.theme` (`src/hud/types.js`).

## Conventions & gotchas

- **Rendering must never throw to the user.** Every layer swallows errors and the shell keeps the last good cached line. Match this: wrap risky work in try/catch, fall back to `null`/empty, and gate noisy logs behind `HUD_DEBUG`.
- **State writes go through `atomicWriteJsonSync` (`src/lib/atomic-write.js`).** Never `fs.writeFileSync` a state/cache file directly — atomicity (temp + `fsync` + rename + dir `fsync`) is required because concurrent sessions race.
- **Cross-process coordination uses `src/lib/file-lock.js`** (`withFileLock`, `lockPathFor`). Lock files sit next to the data file and carry a PID; a lock is stale only when older than the threshold **and** its PID is dead.
- **State is centralized, never written into the user's project.** All runtime files live under one cache dir — by default the HUD install's own `cache/` (derived from the module's location in `getCacheDir`, so it follows a relocated install); `HUD_CACHE_DIR` overrides it and the shell wrapper honors the same var, so the two layers never diverge. Each session gets its **own subfolder** named by the (sanitized) session id, and the files inside drop the suffix: `cache/<session>/hud-state.json`, `.../hud-stdin-cache.json`, `.../compact-requested.json`, `.../subagent-tokens.json` (plus the shell's `stdin.json`, `statusline.txt`, `render.lock`). The globally-unique session id naming the folder keeps unrelated sessions **and** projects from colliding, so there is no per-project subdirectory (and the stdin/stabilization cache can no longer be clobbered across sessions). Always resolve via `src/lib/worktree-paths.js` (`getSessionCacheDir`, `sessionCacheFile`, `ensureSessionCacheDir`); never hardcode. The session key is derived once in `index.js#resolveSessionKey` (`HUD_SESSION_KEY`, the key statusline.sh computed and exported so the two layers can never diverge, even on its checksum fallbacks → stdin `session_id` → session-id env vars → transcript UUID → `default`) and threaded into every cache read/write. Session folders idle longer than `HUD_CACHE_MAX_AGE_DAYS` (default 14) — and legacy flat cache files — are pruned at most once a day from the shell's locked refresh path.
- **Width math uses `stringWidth()` from `src/lib/string-width.js`, not `.length`** (ANSI is stripped first; CJK counts as 2). Emoji/ZWJ width is approximate.
- **`safeMode` (default `true`, and forced on Windows) changes output:** it strips non-SGR ANSI and swaps Unicode bar glyphs for ASCII via `src/hud/sanitize.js`. Outside safe mode, `index.js` replaces spaces with non-breaking spaces (`\u00A0`) for alignment — keep both paths working.
- **Usage/rate-limit data (`src/hud/usage-api.js`)** reads OAuth creds from the macOS Keychain or `~/.claude/.credentials.json`, calls `api.anthropic.com/api/oauth/usage`, and caches per-provider with backoff. It is intentionally suppressed when `ANTHROPIC_BASE_URL` points at a non-Anthropic gateway. Credentials are read-only except a best-effort token-refresh write-back to the file store.
- **`token:` folds in teammate/subagent tokens (`src/hud/subagents.js`).** Claude Code writes each subagent to its own transcript under `<lead-transcript>/subagents/` (sharing the parent `sessionId`), which the lead transcript `parseTranscript` reads never contains — so `sessionTotalTokens` would undercount every multi-agent run (often ~half). **There are two layouts, and the walk must stay recursive to catch both:** Agent-tool teammates land flat at `subagents/agent-*.jsonl`, but Workflow-tool ("ultracode") agents nest one level deeper at `subagents/workflows/wf_<id>/agent-*.jsonl`. A flat `readdir` sees only the `workflows` *directory*, which fails the `agent-` prefix test — so every workflow run scored 0 and hid the bulk of a session's tokens (measured: 667k of 872k on a real 30-agent run). Recursion is hand-rolled: `readdirSync`'s `recursive` option is Node 18.17+ and this project floors at 14.17. Descent is bounded by `MAX_WALK_DEPTH` and follows `isDirectory()` (false for symlinks, so cycles can't trap it). `index.js` adds `sumSubagentTokens(resolvedTranscriptPath, sessionKey)` to a *trustworthy* lead total (null stays null → element still hides); the lead holds no `isSidechain` turns of its own, so this is purely additive with nothing to double-count. Per-file sums are memoized on disk (`subagent-tokens.json`, keyed on size+mtime under each file's path *relative to* the subagents dir) because the one-process-per-render model kills in-memory caches; a static team costs one `stat()` per file. Fails to 0 on any read error, and a single vanished/rotated file is skipped rather than zeroing the team. `MAX_SUBAGENT_FILES` (512) is a backstop, not a budget — one workflow can spawn 1000 agents, so if it ever bites it sums the *largest* files and says so under `HUD_DEBUG`. Note the lead transcript no longer carries inline `isSidechain` entries — the `!entry.isSidechain` guards in `transcript.js`/`prompt-time.js` are now defensive cover for older/forward-compat transcripts, not the live path.
- WSL detection and process-liveness go through `src/lib/platform.js`; plain OS branches (`process.platform === 'win32' | 'darwin'`) still appear inline where simpler.
