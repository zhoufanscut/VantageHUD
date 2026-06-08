# AGENTS.md

Self-contained Claude Code statusline (HUD). Reads one JSON payload on stdin, prints the status line on stdout. Pure Node built-ins, ESM, **zero dependencies**. See `README.md` for end-user setup/proxy/env docs — this file is the agent-specific map.

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

Expect one line containing `opus 4.8 high`. `HUD_SYNC_REFRESH=1` forces a synchronous render (skips the background-cache hot path); `HUD_DEBUG=1` adds stderr diagnostics. To exercise the renderer alone: `... | node statusline.mjs`.

## Execution flow (not obvious from filenames)

```
Claude Code → statusline.sh → find-node.sh → statusline.mjs → src/hud/index.js → src/hud/render.js → src/hud/elements/*.js
```

- `statusline.sh` (POSIX, no bashisms) is a **caching wrapper**, not just a launcher. Hot path = `cat` the last rendered line for this session and kick a background Node refresh for the *next* frame. First render per session is **synchronous** because Claude Code v2.1.x doesn't re-poll until user interaction. Per-session cache + `mkdir`-based render lock live in `cache/` (gitignored). Keep it relocatable: cache path is derived from the script dir, never hardcoded.
- `find-node.sh` locates `node` for non-interactive shells (PATH → nvm → fnm → homebrew) and always `exit 0` so it never blocks Claude Code.
- `statusline.mjs` installs an `HTTPS_PROXY`/`https_proxy` CONNECT tunnel by monkey-patching `node:https` **before** dynamically importing the HUD, then `import()`s `src/hud/index.js`.
- `src/hud/index.js:main()` builds a single `context` object from stdin + transcript + HUD state + usage API, then calls `render(context, config)`.

## Configuration

- User config is **not in this repo**. `src/hud/state.js#readHudConfig()` reads it from Claude Code's `settings.json` (in the resolved config dir) under the **`statusline`** key. Footgun: that lowercase `statusline` config block is **distinct** from the `statusLine` (capital L) command-hook key documented in the README. Precedence: `settings.json` `statusline` > legacy `~/.claude/.claude-statusline/hud-config.json` > defaults.
- Defaults, presets (`minimal`/`focused`/`full`/`opencode`/`dense`), labels (en + zh-CN), and the canonical element order (`DEFAULT_ELEMENT_ORDER`) all live in **`src/hud/types.js`**. Change defaults there.

## Adding or changing a statusline element

An element is a pure function `export function renderXxx(args) → string | null` (return `null` to render nothing; the string is a fragment with **no separators and no newlines** — `render.js` joins fragments with `" | "`). `src/hud/elements/agents.js` is the only multi-line element: it returns `{ headerPart, detailLines }`.

To add one, touch these files (in order):
1. `src/hud/elements/<name>.js` — the render function. Use color helpers from `src/hud/colors.js` (`paint`, `auroraLabel`, `auroraFaint`, `AURORA.*`), never raw escape codes.
2. `src/hud/render.js` — import it, guard on `enabledElements.<name>`, and store the result via `rendered.set("<name>", el)` (inline) or `renderedDetail.set("<name>", [el])` (detail line).
3. `src/hud/types.js` — add the enable flag to `DEFAULT_HUD_CONFIG.elements` and place `"<name>"` in `DEFAULT_ELEMENT_ORDER` (`line1` / `main` / `detail`).
4. `src/hud/index.js` — only if the element needs new data: extract it and add a field to the `context` object.

## Conventions & gotchas

- **Rendering must never throw to the user.** Every layer swallows errors and the shell keeps the last good cached line. Match this: wrap risky work in try/catch, fall back to `null`/empty, and gate noisy logs behind `HUD_DEBUG`.
- **State writes go through `atomicWriteJsonSync` (`src/lib/atomic-write.js`).** Never `fs.writeFileSync` a state/cache file directly — atomicity (temp + `fsync` + rename + dir `fsync`) is required because concurrent sessions race.
- **Cross-process coordination uses `src/lib/file-lock.js`** (`withFileLock`, `lockPathFor`). Lock files sit next to the data file and carry a PID; a lock is stale only when older than the threshold **and** its PID is dead.
- **State is centralized, never written into the user's project.** By default it lives at `<hud-install>/.claude-statusline/<project-id>/` — the base is derived from the module's own location in `getStateRoot` (so it follows a relocated install), and `<project-id>` keeps unrelated projects from colliding. `HUD_STATE_DIR` overrides the base dir. Always resolve via `src/lib/worktree-paths.js` (`getStateRoot`, `resolveSessionStatePath`); never hardcode. `validateWorkingDirectory()` returns the git **worktree root**, never a subdirectory — it's used only to derive `<project-id>` — and paths are validated against `..`/absolute traversal.
- **Width math uses `stringWidth()` from `src/lib/string-width.js`, not `.length`** (ANSI is stripped first; CJK counts as 2). Emoji/ZWJ width is approximate.
- **`safeMode` (default `true`, and forced on Windows) changes output:** it strips non-SGR ANSI and swaps Unicode bar glyphs for ASCII via `src/hud/sanitize.js`. Outside safe mode, `index.js` replaces spaces with non-breaking spaces (`\u00A0`) for alignment — keep both paths working.
- **Usage/rate-limit data (`src/hud/usage-api.js`)** reads OAuth creds from the macOS Keychain or `~/.claude/.credentials.json`, calls `api.anthropic.com/api/oauth/usage`, and caches per-provider with backoff. It is intentionally suppressed when `ANTHROPIC_BASE_URL` points at a non-Anthropic gateway. Credentials are read-only except a best-effort token-refresh write-back to the file store.
- WSL detection and process-liveness go through `src/lib/platform.js`; plain OS branches (`process.platform === 'win32' | 'darwin'`) still appear inline where simpler.
