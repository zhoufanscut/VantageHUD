# GLOSSARY.md

Shared vocabulary for this repo, so a human and an agent mean the same thing by
the same word. Terms map to real code — file pointers given where they help.

Deliberately lean: only the words that actually come up *and* can mislead. The
**[Easy to confuse](#easy-to-confuse)** table is the heart — start there if you're
skimming. Add a term back (or a new one) when it earns its place; keep this short.

---

## Pipeline (data flow)

- **HUD** — this whole program: the self-contained Claude Code statusline in this
  repo. "The HUD" = the project, not one file.
- **statusline** *(the thing)* — the single line Claude Code renders at the bottom
  of the session; the HUD's output. (Distinct from the config key and hook key of
  the same spelling — see *Easy to confuse*.)
- **payload** / **stdin JSON** — the one JSON object Claude Code pipes in per
  render (`session_id`, `cwd`, `model`, `effort`, `context_window`, …). The sole
  live input (`src/hud/stdin.js`).
- **transcript** — the conversation log (`.jsonl`); parsed (`src/hud/transcript.js`)
  for agents, todos, tokens, last tool/skill. A *second* input, distinct from the
  payload.
- **render context** — the object `index.js#main()` assembles from payload +
  transcript + state + usage API and hands to `render()`. **Not** the model's
  context window (see *Easy to confuse*).
- **element** — a pure render function `renderXxx(args) → string | null`, one per
  file in `src/hud/elements/`. Returns `null` to render nothing.
- **fragment** — the string an element returns: **no separators, no newlines**.
  `render.js` joins fragments with ` | `.
- **detail line** — a full extra line *below* the main line (agents, todos,
  warnings), vs an inline fragment. `agents.js` is the only element that emits one,
  via `{ headerPart, detailLines }`.

## Layout & config

- **line1 / main / detail** — the three render zones (`DEFAULT_ELEMENT_ORDER`,
  `src/hud/types.js`). `line1` = top line (above `main` by default); `main` = the
  primary status line; `detail` = the multi-line extras under it. User config can
  reorder them.
- **preset** — a named bundle of element toggles: `minimal | focused | full |
  opencode | dense`. Default `focused` (`PRESET_CONFIGS`, `types.js`).

## Theming

- **theme** — a named palette: `aurora` (default; cool slate) or `ember` (warm
  gruvbox). Resolved at import in `themes.js`: `HUD_THEME` env > `settings.json`
  `statusline.theme` > `DEFAULT_THEME`.
- **palette** / **token** — the color *data* behind a theme: 14 named `[r,g,b]`
  **tokens** (`text`, `label`, `accent`, `gradLow/Mid/High`, …). Defined only in
  `THEMES` (`src/hud/themes.js`); every element colors through them.

## Runtime & state

- **session key** — the sanitized id naming every per-session cache file and the
  `cache/<session>/` folder. Resolved once (`index.js#resolveSessionKey`):
  `HUD_SESSION_KEY` > stdin `session_id` > session-id env vars > transcript UUID >
  `default`. Not the same as the raw **session id** (see *Easy to confuse*).
- **cache dir** — `cache/` under the install (`HUD_CACHE_DIR` overrides); each
  session gets its own `cache/<session>/` subfolder. Resolve via
  `src/lib/worktree-paths.js` — never hardcode.
- **smoke test** — the only verification (no tests/linter/CI): pipe a sample
  payload through `statusline.sh`, expect a line containing `opus 4.8 high`. See
  `AGENTS.md` › Verification.

## Common elements

- **effort** / **effort level** — the thinking-effort tier (`high`, …) from the
  payload, shown next to the model.
- **ctx** / **context bar** — context-window usage %, the `contextBar` element.
- **rate limits** / **buckets** — usage windows: five-hour (`5h`), seven-day
  (`7d`), Opus/Sonnet weekly, monthly. From the payload + the usage API
  (`src/hud/usage-api.js`).
- **safeMode** — default `true` (forced on Windows): strips non-SGR ANSI and swaps
  Unicode bars for ASCII (`src/hud/sanitize.js`). Changes the output, so worth
  naming.

---

## Easy to confuse

The pairs most likely to make us talk past each other:

| These look alike… | …but mean different things |
| --- | --- |
| `statusline` *(thing)* / `statusline` *(lowercase config key)* / `statusLine` *(capital-L hook key)* | the rendered line / the HUD's config block in `settings.json` / Claude Code's command-hook key in the README. |
| **render context** / **context window** (`ctx`) / "context" *(the chat)* | the object passed to `render()` / the model's token budget % / the conversation history. In code, "context" usually means the first. |
| **AURORA** / **aurora** | `AURORA` = back-compat alias for the *active* `PALETTE` (any theme) / `aurora` = one specific theme name. |
| **session key** / **session id** | the cache-folder name (sanitized, sometimes a checksum) / Claude Code's conversation UUID (one input to the key). |
| **element** / **enable flag** | the `renderXxx()` function / the config boolean (often same name) that gates it. |
| `gitInfoPosition` / where git renders | the flag positions the whole **`line1`** zone above/below `main` (binary: `"above"` vs not); by default **git is inline in `main`**, not on `line1` — the name is legacy. |
| `DEFAULT_HUD_CONFIG.theme` / the real switch | that field is **documentation-only**; the active theme is resolved in `themes.js` (`HUD_THEME` / `settings.json`). |
| **HUD** / **statusline.sh** / **statusline.mjs** | the project / the shell caching wrapper / the Node entry point. |
| `src/lib/` / `src/utils/`, `src/cli/utils/`, `src/platform/` | `src/lib/` is the current home for shared utils; the others are the **old** locations it moved from — import from `../lib/…`. |
