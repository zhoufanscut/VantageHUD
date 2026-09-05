# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The smoke test showed the previous frame.** With a cached render present,
  `HUD_SYNC_REFRESH=1` printed the cached line first and only then re-rendered,
  so the documented verification command reflected the *last* payload, not the
  one piped in — a code change looked like it had no effect until the second
  run. It now bypasses the cache and prints the fresh render.
- **`callCounts` truncated on large transcripts.** The tool/agent/skill counts
  were read from the last 4 MiB of the lead transcript, so on any larger
  session they undercounted (measured on a 4.9 MB transcript: 442 of 494 tool
  calls, 2 of 3 agent calls) and could run backwards as the window slid — the
  same defect 0.4.0 fixed for `token:`. They now come from the same incremental,
  memoized whole-file tally, and so does the session start.
- **A `[HUD] run /setup to install properly` line pointed at a command this
  project does not have.** Any uncaught render error now prints
  `[HUD] HUD error - check stderr`, with the stack in
  `cache/<session>/statusline.err`.
- **Proxy tunnel.** Credentials in `HTTPS_PROXY` (`http://user:pass@proxy:3128`)
  are sent as `Proxy-Authorization`, `https://` proxies are dialed over TLS,
  a CONNECT the proxy refuses (407, 403) fails the request cleanly instead of
  attempting a TLS handshake on the proxy's error page, and a proxy that
  accepts the connection but never answers the CONNECT no longer hangs the
  render forever (10 s bound; reproduced before the fix).
- **Fresh payload rate limits were marked stale.** When the usage API fell back
  to cached data (network error, or now an expired token), its `stale` flag
  also painted the `*`/`~` marker on the `5h`/`7d` values that had just
  arrived live in the payload. The flag is now dropped whenever the payload
  supplies those buckets. Relatedly, a payload carrying only one of the two
  windows no longer wipes the other window's API value (latent: Claude Code
  sends both), and a rate-limit set with neither window renders nothing
  instead of `5h:NaN%`.
- **`gitStatus` vanished on large untracked trees.** `git status --porcelain`
  ran with `execFileSync`'s 1 MiB default `maxBuffer`, which throws rather
  than truncates — reproduced with 16,000 untracked files (1.2 MB of output):
  the fragment silently disappeared. Raised to 16 MiB, as `svn status`
  already was.

### Changed

- **The HUD no longer refreshes an expired OAuth token.** Refresh tokens are
  single-use: a refresh from a statusline hook revokes the access token Claude
  Code itself holds and forces a re-login
  ([anthropics/claude-code#42603](https://github.com/anthropics/claude-code/issues/42603)).
  Credentials are now strictly read-only. While a token is expired the last
  good numbers show stale-marked (`*`) for up to 15 minutes, then
  `[API auth]`, until Claude Code refreshes the store itself. Current Claude
  Code carries `rate_limits` in the payload, which take precedence, so the
  `5h`/`7d` figures are unaffected.
- `session:` hides when there is no transcript instead of reading `0m`.

### Removed

- `cache/<session>/hud-state.json`. The session start it persisted is now part
  of the tally memo (`lead-tokens.json`); leftover files are inert and go with
  their session folder.

## [0.4.0] - 2026-08-23

Themes you can pick and write yourself, Subversion support, and a `token:`
counter that is finally correct.

### Added

- **Three more bundled themes**, bringing the total to five: `nebula` (vivid
  mauve and pink, Catppuccin Mocha family), `graphite` (near-monochrome — only
  the usage ramp carries hue), and `daylight` (GitHub-light family, the first
  palette built for a **light** terminal background). `aurora` remains the
  default.
- **Custom themes**, defined under a new `themes` key in `config.json` and
  selected by `theme` (or `HUD_THEME`). A palette sets any subset of the 10
  color tokens as `#rrggbb`; the rest are inherited from `base`, which defaults
  to the palette's own name when it shadows a bundled theme — so naming yours
  `ember` retints ember in place. Colors only: glyphs, the separator and the
  70/85 thresholds stay out of a theme, so a color can never disagree with the
  `COMPRESS?` text beside it.
- **`preview-themes.mjs`**, which renders every theme — bundled and your own —
  as a sample line so they can be compared in one screen. `--depth=0|1|2`
  previews the color-depth fallbacks, `--ascii` previews `safeMode`'s glyphs.
- **Subversion checkouts** now fill the `repo:`, `branch:` and status slots,
  under the same three config keys as git — there are no `svn*` flags. The
  branch is parsed from the checkout URL (`trunk`, `branches/<name>`,
  `tags/<name>`) with the revision appended: `branch:2.1@12345`. Both
  `wc-status` columns are counted, so a property-only change no longer reads as
  clean — the normal state of every merge root, since `svn merge` writes
  `svn:mergeinfo` there. Git wins ties, and a git checkout never spawns `svn`.
- A `## Themes` section in the README documenting all five palettes, their hex
  values, and what each of the 10 color tokens paints.

### Fixed

- **`token:` counted every API call 2–4 times.** Claude Code writes one
  transcript row per assistant content block — `thinking`, `text`, each
  `tool_use` — all sharing one `message.id` and each carrying that call's usage.
  Summing rows inflated the total by a median 2.46× (max 4.11×) across 159
  transcripts.
- **`token:` truncated long sessions.** The lead transcript was read from its
  last 4 MiB but published as a complete session total — 739,480 against a true
  1,910,334 on a 25.4 MB transcript. Because the window was a fixed byte count,
  one large tool result could evict usage rows and drive the counter
  *backwards*. Counting now runs through a single incremental, de-duplicating
  tally shared by the lead and every teammate transcript.
- **Workflow subagents scored zero.** Workflow-tool ("ultracode") agents nest a
  directory deeper than Agent-tool teammates, so the flat listing never saw
  them. On a live 30-agent session `token:` read 205k against 872k of real
  usage — 76% invisible, exactly when the number matters most.
- **`gitStatus` scored unmerged paths as staged.** They now count as conflicts.

### Removed

- **The `promptTime` element.** It gauged prompt-cache age against a hardcoded
  5-minute TTL and turned red at 4m15s, but every cache-creation token measured
  on disk is `ephemeral_1h` — so it cried "cold cache" 12× too early.

## [0.3.0] - 2026-07-05

First public release — a small, self-contained statusline for Claude Code that
shows the model, thinking effort, context, rate limits, and git at a glance.

[Unreleased]: https://github.com/zhoufanscut/VantageHUD/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/zhoufanscut/VantageHUD/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zhoufanscut/VantageHUD/releases/tag/v0.3.0
