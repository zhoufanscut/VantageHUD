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
  for tool/agent/skill counts, todos, tokens, last tool/skill. A *second* input,
  distinct from the payload.
- **render context** — the object `index.js#main()` assembles from payload +
  transcript + state + usage API and hands to `render()`. **Not** the model's
  context window (see *Easy to confuse*).
- **element** — a pure render function `renderXxx(args) → string | null`, one per
  file in `src/hud/elements/`. Returns `null` to render nothing.
- **fragment** — the string an element returns: **no separators, no newlines**.
  `render.js` joins fragments with ` | ` into the single status line.

## Layout & config

- **config.json** — the HUD's own user-config file at the install root
  (`getHudConfigFile`, `src/lib/install-paths.js`; `HUD_CONFIG` overrides).
  Optional, gitignored; `config.json.example` is the committed reference. Read
  directly (`readHudConfig`), independent of Claude Code's `settings.json`. Its
  top-level object **is** the config — no wrapper key.
- **main** — the HUD's single render zone: the one status line. Element order is
  `DEFAULT_ELEMENT_ORDER.main` (`src/hud/types.js`); `layout.main` / `elementOrder`
  reorder it. (The HUD was formerly three zones — `line1` / `main` / `detail` — but
  is now single-line, so only `main` remains.)

## Theming

- **theme** — a named palette: one of the five bundled (`aurora` default cool
  slate, `ember` warm gruvbox, `nebula` vivid mauve, `graphite` near-monochrome,
  `daylight` for light terminals), or one the user defines under `config.json`
  `themes`. `node preview-themes.mjs` renders them all. Resolved
  at import in `themes.js`: `HUD_THEME` env > `config.json` `theme` >
  `DEFAULT_THEME`; both tiers search bundled **and** user themes.
- **palette** / **token** — the color *data* behind a theme: 10 named **tokens**
  (`text`, `label`, `gradLow/Mid/High`, …), authored as `#rrggbb` in `THEMES`
  (`src/hud/themes.js`) and in `config.json` alike. `themes.js` converts them to
  the `[r,g,b]` triples `colors.js` consumes; every element colors through them.
- **user theme** — an entry under the `config.json` `themes` key. May set any
  subset of the 10 tokens; the rest come from **`base`**.
- **`base`** — reserved key inside a user theme naming the palette to inherit
  unset tokens from. Never an 11th token. Defaults to the theme's *own* name when
  it shadows a bundled palette, else to `DEFAULT_THEME` — so `"themes": {"ember":
  {…}}` retints ember in place, and its `base` resolves to the *bundled* ember
  rather than looping.

## Runtime & state

- **session key** — the sanitized id naming every per-session cache file and the
  `cache/<session>/` folder. Resolved once (`index.js#resolveSessionKey`):
  `HUD_SESSION_KEY` > stdin `session_id` > session-id env vars > transcript UUID >
  `default`. Not the same as the raw **session id** (see *Easy to confuse*).
- **cache dir** — `cache/` under the install (`HUD_CACHE_DIR` overrides); each
  session gets its own `cache/<session>/` subfolder. Resolve via
  `src/lib/worktree-paths.js` — never hardcode.
- **smoke test** — the only verification (no tests/linter/CI): pipe a sample
  payload through `statusline.sh`, expect a line containing `opus high`. See
  `AGENTS.md` › Verification.

## Common elements

- **effort** / **effort level** — the thinking-effort tier (`high`, …) from the
  payload, shown next to the model.
- **ctx** / **context bar** — context-window usage %, the `contextBar` element.
- **rate limits** / **buckets** — usage windows: five-hour (`5h`), seven-day
  (`7d`), Opus/Sonnet weekly, monthly. From the payload + the usage API
  (`src/hud/usage-api.js`).
- **token** / **subagents dir** / **teammate tokens** — the `token:` element's
  session token total (`sessionTotalTokens`) / `<lead-transcript>/subagents/` where
  Claude Code stores each subagent's own `agent-*.jsonl` transcript — flat for
  Agent-tool teammates, but nested under `workflows/wf_<id>/` for Workflow-tool
  ("ultracode") agents, which is why `src/hud/subagents.js` walks it recursively /
  the tokens those subagents spend, which that module folds into
  `token:` so it reflects the whole run, not just the lead thread.
- **`gitRepo` / `gitBranch` / `gitStatus`** — the three **VCS slots**, not
  git-only elements: git answers first (`src/hud/elements/git.js`) and
  Subversion fills a slot only when git returns nothing
  (`src/hud/elements/svn.js`). The config keys keep their `git*` names.
- **working copy** *(SVN)* — the SVN counterpart to a git worktree: the tree
  holding a `.svn` directory. `findSvnWorkingCopyRoot`
  (`src/lib/worktree-paths.js`) finds its root by filesystem walk, never by
  running `svn`.
- **safeMode** — default `true` (forced on Windows): strips non-SGR ANSI and swaps
  Unicode bars for ASCII (`src/hud/sanitize.js`). Changes the output, so worth
  naming.

---

## Easy to confuse

The pairs most likely to make us talk past each other:

| These look alike… | …but mean different things |
| --- | --- |
| `statusline` *(thing)* / `config.json` *(HUD config)* / `statusLine` *(capital-L hook key)* | the rendered line / the HUD's own config file at the install root (`getHudConfigFile`) / Claude Code's command-hook key in `settings.json` (README). The HUD's config is its **own** file — not a block inside `settings.json`. |
| **render context** / **context window** (`ctx`) / "context" *(the chat)* | the object passed to `render()` / the model's token budget % / the conversation history. In code, "context" usually means the first. |
| **session key** / **session id** | the cache-folder name (sanitized, sometimes a checksum) / Claude Code's conversation UUID (one input to the key). |
| **element** / **enable flag** | the `renderXxx()` function / the config boolean (often same name) that gates it. |
| **branch** *(git)* / **branch** *(SVN)* | a real ref / a URL convention — `trunk`, `branches/<name>`, `tags/<name>` parsed out of the checkout URL, since SVN has no branches. |
| `DEFAULT_HUD_CONFIG.theme` / `.themes` / the real switch | both fields are **documentation-only** (`mergeWithDefaults` drops them); the active palette is resolved in `themes.js` from its own import-time read of `config.json` (`HUD_THEME` env first). |
| **HUD** / **statusline.sh** / **statusline.mjs** | the project / the shell caching wrapper / the Node entry point. |
| `src/lib/` / `src/utils/`, `src/cli/utils/`, `src/platform/` | `src/lib/` is the current home for shared utils; the others are the **old** locations it moved from — import from `../lib/…`. |
