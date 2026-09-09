# Lite TUI — full UI/UX parity plan

Goal: rebuild `lite tui` to 100% UI/UX and feature parity with the reference
terminal client, verified feature-by-feature in a real PTY. This plan is the
authoritative tracker; each phase lands as one or more commits with unit tests
plus a scripted PTY driver run.

## Renderer decision

The reference client is built on the open-source `@opentui` terminal UI
runtime (MIT). Nearly all of its visual polish — scrollboxes with sticky
scroll, mouse hover/click/drag, copy-on-select, markdown and syntax-highlighted
code rendering, split/unified diffs, zIndex-layered dialogs with alpha scrims,
virtual extmark pills inside the textarea, kitty keyboard protocol — comes from
that runtime's intrinsics. Replicating those primitives on top of raw ANSI in
plain Node is the bulk of the cost of a rebuild and is where the current v1
TUI falls visibly short.

Probe results (real PTY, isolated sandbox):

- `@opentui/core` 0.5.11 renders correctly, but only under the Bun runtime
  (its native FFI layer does not load under plain Node).
- Bun installs cleanly as an npm dependency (`npm install bun`, ~59MB) and
  `./node_modules/.bin/bun` v1.4.2 runs the renderer.
- Keyboard input verified end-to-end under Bun in a PTY **with the renderer
  options the reference uses** (`useKittyKeyboard: {}`, `exitOnCtrlC: false`,
  `autoFocus: false`, `externalOutputMode: "passthrough"`, `targetFps: 60`,
  `gatherStats: false`). With default options key events did not surface.
- `@opentui/react` works via `createRoot(renderer).render(<App/>)`.

**Decision: adopt `@opentui/react` for the TUI client process, running under
Bun.** The Lite server stays pure Node (it depends on `node:sqlite`); the TUI
is only an HTTP/SSE client, so `bin/lite.mjs tui` re-execs the TUI entry under
the local Bun binary. React (already used by the web client) keeps one UI
framework across both clients. The existing zero-dependency TUI remains as
`--legacy` fallback until Phase 8 removes it.

Consequences to accept and document:

- `bun` becomes a dependency of the `tui` subcommand only; `serve` never
  needs it. The shim prints a clear installation hint if the binary is absent.
- TUI component tests run under `bun test` or as pure-logic vitest tests for
  everything extracted out of components (keymap resolution, theme parsing,
  autocomplete ranking, prompt part bookkeeping — keep those framework-free).

## Definition of parity

Parity is judged against the reference's actual source behavior (inventoried
exhaustively across six areas: transcript rendering, app shell/layout,
dialogs/palette, session interactions, keymap/theme/config, prompt editor),
not against its docs. Known reference bugs/dead code (dead footer component,
docs-only "username display", dead subagent/tag dialogs) are explicitly out of
scope. Features that require server capabilities Lite lacks get the server
work scheduled in the same phase.

## Feature matrix (reference feature → Lite v1 status → phase)

Status key: ✗ missing · ◐ partial (v1 has a basic version) · ✓ present.

### Foundation
| Feature | v1 | Phase |
|---|---|---|
| GPU-composited grid renderer, 60fps, passthrough output | ✗ | 1 |
| Kitty keyboard protocol + bracketed paste (CRLF/CR normalize, empty-paste fallback) | ✗ | 1 |
| Mouse support (hover, click, drag, scroll w/ speed+acceleration config) | ✗ | 1 |
| Copy-on-select (mouse selection → clipboard) | ✗ | 1 |
| Clipboard write = OSC52 always + native fallback chain, tmux/screen passthrough | ✗ | 1 |
| Clipboard read, image-first, per-platform | ✗ | 6 |
| Theme system: 51 tokens, ref resolution w/ cycle detection, ANSI→RGBA | ✗ | 2 |
| 33 built-in themes + system theme from OSC-11/palette (gray ramp, transparent bg) | ✗ | 2 |
| Live terminal light/dark switch (OSC 2031), SIGUSR2 hot reload | ✗ | 2 |
| Config file `tui.json(c)`: global→env-override→project merge, `{env:}`/`{file:}` substitution | ✗ | 2 |
| Keymap engine: leader (ctrl+x, 2000ms), mode stack, comma alternatives, aliases, base-layout fallback | ✗ | 2 |
| Complete default binding table (~152 actions incl. full readline-ish input set) | ✗ | 2 |
| SSE sync: 16ms coalescing, exp backoff (no reset), silent disconnect, replay | ◐ | 1 |
| Startup loading screen (500ms grace/3000ms), crash screen | ✗ | 1 |
| Terminal title `Lite | <session title>` (truncated) | ✗ | 6 |
| Suspend ctrl+z (SIGTSTP/SIGCONT), Windows guards | ✗ | 6 |

### App shell & layout
| Feature | v1 | Phase |
|---|---|---|
| Home route: elastic spacers, logo w/ shadow chars, rotating tips (106) | ✗ | 3 |
| Session route: headerless layout, contentWidth math | ◐ | 3 |
| Sidebar: 42-col docked when width>120 else overlay w/ alpha scrim; Context/MCP/Todo/Modified-Files sections | ✗ | 6 |
| Prompt chrome status rows (agent/model row, shadow row, spinner/retry/usage/shortcut row) | ◐ | 4 |
| Sticky scroll + scroll command set (line/page/half/top/bottom) | ✗ | 3 |
| Toast system: single-slot top-right, split border, 5s | ✗ | 5 |
| Exit epilogue ANSI wordmark (session route only), SIGHUP handling | ✗ | 6 |

### Prompt editor
| Feature | v1 | Phase |
|---|---|---|
| Bordered prompt panel (`┃` left border, `╹`/`▀` shadow, padded textarea) | ✗ | 4 |
| Multiline textarea: word wrap, maxHeight max(6, h/3), grapheme-aware width | ◐ | 4 |
| Managed input keymap (35 commands: word nav/kill/undo, newline variants, IME-safe submit) | ✗ | 4 |
| Shell mode via leading `!` (styled, esc/backspace exit, parts discarded) | ✗ | 4 |
| `/` command + `@` file autocomplete (fuzzy w/ frecency, server fs.find, above-prompt popup) | ◐ | 4 |
| File/agent/paste pills (virtual extmarks) synced to prompt parts | ✗ | 4 |
| Image/PDF paste as attachments, `[Image N]` placeholders; path paste → attachment | ✗ | 4 |
| Large-paste collapse `[Pasted ~N lines]` | ✗ | 4 |
| Line-range references `@file#12-40` | ✗ | 4 |
| Prompt history (JSONL, 50, dup-dedupe, dirty guard, down-past-newest clears) | ✗ | 4 |
| Prompt stash (LIFO + dialog, two-press delete) | ✗ | 4 |
| External editor `$VISUAL`/`$EDITOR` round-trip w/ part re-anchoring | ✗ | 6 |
| Mode/agent cycling (tab/shift+tab), placeholder rotation, fade-in meta row | ◐ | 4 |
| ctrl+c clears (saves to history if long), 2-press esc interrupt | ◐ | 4 |

### Transcript & tool rendering
| Feature | v1 | Phase |
|---|---|---|
| Markdown rendering (14 themed markdown tokens) | ✗ | 3 |
| Syntax-highlighted code blocks (tree-sitter grammars, ~70 scopes, thinking variant) | ✗ | 3 |
| User message: left-rail `┃` panel, agent-colored | ✗ | 3 |
| Assistant footer `▣ {mode} · {model} · {duration}`; `· interrupted` suffix | ✗ | 3 |
| Reasoning parts collapsible `+/- Thought:` | ✗ | 3 |
| Per-tool renderers: bash (10-line clip), write (numbered), edit (diff, split>120 else unified), read/glob/grep/webfetch/websearch/task/todo icons+collapse rules | ◐ | 3 |
| Knight-Rider scanner while working (40ms, width 8) | ✗ | 3 |
| Diff viewer mode (keys m [ ] n p v b s d ?, file nav, wrap toggle) | ✗ | 5 |
| Queued-message badge, no optimistic insert; hydration anti-clobber | ✗ | 3 |
| Retry countdown inline; error suppression for aborted/denied | ◐ | 3 |

### Dialogs & palette
| Feature | v1 | Phase |
|---|---|---|
| Dialog shell: zIndex layering, alpha scrim, esc-pops-one/backdrop-clears-all | ✗ | 5 |
| Select dialog: fuzzy (title ×2), wraparound, hover, live footer keymap labels | ◐ | 5 |
| Command palette (ctrl+p): reachable-visibility, Suggested group | ✗ | 5 |
| Model picker: Favorites/Recent/provider groups, favorite toggle | ◐ | 5 |
| Theme picker with live preview + revert-on-cancel | ✗ | 5 |
| Session list: debounce, two-press delete | ◐ | 5 |
| Timeline dialog with live scrub | ✗ | 7 |
| Message actions: revert / copy / fork | ✗ | 7 |
| Alert/Confirm/Prompt/Help/Export primitives | ◐ | 5 |
| Which-key panel (opt-in, dock/overlay, max 3 cols) | ✗ | 5 |

### Session interactions
| Feature | v1 | Phase |
|---|---|---|
| Permission prompt in-transcript (replaces prompt, warning border, per-kind preview incl. full diff, ctrl+f fullscreen) | ◐ | 7 |
| Permission chips once/always/reject, mouse hover/click, "always until restart" server persistence, reject-cascades | ◐ | 7 |
| Auto-approve mode flags (`--auto`) with `auto` footer label | ✗ | 7 |
| Question prompt: tab strip, digit jump, multi-select `[✓]`, custom answer textarea | ◐ | 7 |
| 2-press esc interrupt (5s window, hint flip) | ✗ | 4 |
| Undo/redo turns (leader+u/r): revert restores prompt text+parts, revert banner, reverted tail hidden | ◐ | 7 |
| Subagent navigation: click into child, leader+arrows, footer chips `(i of n)` | ✗ | 7 |
| Notifications: terminal attention on question/permission/done (opt-in), sounds | ✗ | 6 |
| Session fork | ✗ | 7 |

Server work needed alongside: fs.find frecency endpoint (P4), permission
"always" persistence + cascade semantics (P7), fork endpoint (P7), message
revert metadata (P7), attachment upload parts (P4).

## Phases

Every phase ends with: unit tests green (`npm test`), scripted PTY driver run
(`tui-drive` steps file) proving the phase's visible behaviors, a commit.

- **Phase 1 — Renderer foundation.** Bun re-exec shim in `bin/lite.mjs`;
  `tui2/` React app scaffold with the verified renderer options; port the SSE
  sync layer onto the shared `applyEvent` reducer with 16ms coalescing and
  reference backoff; startup loading + crash screens; basic transcript
  scrollbox with sticky scroll; keep `--legacy` path. Exit criteria: open a
  session, see streamed text live, scroll, quit cleanly — under Bun in PTY.
- **Phase 2 — Theme, config, keymap engines.** Token system (51 tokens),
  built-in themes, system theme detection, live mode switch; `tui.json(c)`
  loading/merging/substitution; keymap engine with leader, modes, aliases,
  full default table. All engine logic framework-free with vitest coverage.
- **Phase 3 — Transcript parity.** Markdown + syntax highlighting, user/
  assistant message chassis, reasoning collapse, all per-tool renderers with
  the reference's icons and collapse rules, working scanner, queued badge,
  retry/error styling.
- **Phase 4 — Prompt editor parity.** Bordered prompt chrome + status rows,
  managed textarea keymap, shell mode, autocomplete (slash + @ mentions with
  frecency), pills/parts model, paste handling (images/large-paste), history,
  stash, interrupt hint.
- **Phase 5 — Dialogs & palette.** Dialog shell + layering, select dialog,
  palette, model/theme/session pickers, toasts, which-key, help/export.
- **Phase 6 — Shell polish.** Sidebar (docked/overlay), terminal title,
  clipboard read, notifications/sounds, external editor, suspend, exit
  epilogue, home screen tips.
- **Phase 7 — Deep session interactions.** Full permission/question prompts
  with previews and fullscreen, auto-approve, undo/redo with revert banner,
  timeline, fork, message actions, subagent navigation; matching server
  endpoints.
- **Phase 8 — Verification sweep & cutover.** Walk the entire matrix in PTY
  driver scripts, fix gaps, remove `--legacy`, update docs. Honest gap report
  for anything intentionally divergent.

## Verification harness

The existing node-pty driver (steps JSON: wait-regex/sleep/send) runs the TUI
under Bun against the isolated e2e server on port 3211 (fixture provider).
Each phase adds a steps file under `tests/tui-e2e/` so the parity claims stay
reproducible.
