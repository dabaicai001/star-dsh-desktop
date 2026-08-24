# Agent Note: StarHub screenshot drag/region, window-mode dispatch, and the header git branch pill visibility fixes

Status: implemented

## Problem

Four user-visible defects shipped on the StarHub `feat/ai-screenshot` line (`shell-placeholder/screenshot.html`, `src-tauri/src/commands/screenshot.rs`, `packages/starhub/client-nav` git branch pill, and `packages/client/ui-conversation` session header):

1. **Region screenshot could not be drag-selected.** The overlay page stacks three full-window canvases — `#base` (desktop image + mouse listeners), `#anno` (annotation rectangles), `#overlay` (dim mask / selection / handle highlights). All three are `position: absolute` siblings; the last painted (`#overlay`) sits on top and, with default `pointer-events: auto`, intercepts every `mousedown`/`mousemove`/`click` before they can reach `#base`. The drag/click listeners on `baseCanvas` therefore never fire — earlier rounds misdiagnosed this as canvas sizing, DPI coordinate math, or IPC byte handling.
2. **Window screenshot showed only a black screen.** `initWindow()` was defined in `screenshot.html` but never called: the page unconditionally ran `initRegion()`, so in window mode `screenshot_get_desktop` (which returns `Err` because `ScreenshotSession.desktop` is `None`) failed immediately — black overlay plus an "initialization failed" hint. The whole window-picking flow (`screenshot_list_windows`, hover highlight, click-to-capture) was dead code.
3. **A new (blank) session page did not show the git branch pill.** `ConversationSessionHeader` hid the entire header (`blank && composerPhase === 'blank'`) while a session had zero messages, so the `conversation.session.header.actions` seat hosting `GitBranchPill` was never visible on the new-session hero.
4. **The branch panel partially occluded against the left sidebar.** The panel was anchored `right: 0` and opened leftward; the pill sits beside the title crumb — near the left edge of the conversation column — so the 340px panel crossed the column's left boundary and the column's `overflow` clipped it, reading as "covered by the sidebar". The pill root's stacking context at `z-index: 9` also sat under the shell overlay layer (`z-index: 20`).

## Decision

- **`screenshot.html`:** `#anno` and `#overlay` are pure visual layers; they now carry `pointer-events: none` so every pointer event lands on `#base`, whose existing hit-testing (`hitTest`, drag state machine, window-mode hover/click) drives the interaction. No listener changes were needed — the listeners were always correct, the events just never arrived.
- **Window-mode dispatch:** `screenshot_begin_window` now creates the overlay with `WebviewUrl::App("screenshot.html?mode=window")` (`overlay_url(mode)` in `screenshot.rs`; region keeps the bare page). The page reads `new URLSearchParams(location.search).get('mode')` and calls `initWindow()` for window mode and `initRegion()` otherwise. `initWindow()` is no longer dead: it sizes the canvases to the virtual screen, lists windows (`screenshot_list_windows`), paints hover highlights, and captures on click.
- **Blank-session header:** `hideChrome` becomes `blank && composerPhase === 'blank' && openState !== 'open'` — the header hides only while the session is still opening (settling/replay), and stays visible once the blank session is open, so the new-session page shows the branch pill (its `cwd` data source is present once the host frame lands; `workspaces` blank-session reuse already keys on that `cwd`).
- **Branch panel geometry:** `.panel` anchors `left: 0` and opens rightward into the conversation column, away from the sidebar boundary; the pill root's `z-index` moves from 9 to 30 so the panel also clears the shell overlay layer (20).

## Alternatives considered

**Make the overlay canvases siblings but listen on `#stage`/`document` instead.** Works, but a document-level `mousedown` would also start selection when the user clicks the toolbar/wins/exit chrome — every chrome element would need its own stopPropagation. `pointer-events: none` on the two pure-visual canvases is the minimal correct fix: chrome keeps its own handlers and `#base` keeps its listeners.

**Have the overlay page probe `screenshot_get_desktop` and fall back to window mode on the "no desktop capture cached (window mode)" error.** Zero Rust change but string-matching an error message to select a mode is brittle and would regress the fail-loud behavior if the message ever changes. Passing the mode in the window URL is deterministic and keeps the two init paths explicit.

**Register the git branch pill into the hero workspace row (`conversation.hero.workspace`) instead of changing `hideChrome`.** That slot is `root`-scoped and its `PropsRuntime` carries no `sessionId`, and it is a single seat shared with the workspace picker — the pill cannot derive the session cwd there without core slot changes. Adjusting `hideChrome` to hide only during the opening round-trip reuses the existing header seat and preserves the settling behavior.

**Raise only `.panel`'s z-index without moving the anchor.** The panel's stacking context is rooted at `.root` (z 9 vs 30), so raising it inside changes nothing against the shell overlay; and the real occlusion was horizontal clipping by the column, which no z-index can fix.

## Consequences

Region drag-selection and window click-to-capture now work (the two overlay modes share one page, distinguished by URL); a new-session page shows the branch pill over the workspace's git repo; and the branch panel opens into the column instead of under the sidebar edge. Cost: `screenshot.html` mode now lives in the URL (a page loaded with an unknown/no `mode` falls back to region), and the header is no longer chrome-hidden for open blank sessions — the hero gains the title/actions row above it, which the `ui-conversation` skeleton spec now pins (`hero phase` asserts a visible header and `conversation.session.header.actions` rendering while the settling specs still assert the hidden header). The [git branch pill feature note](../feature/2026-08-21-starhub-session-header-git-branch-pill.md) owns the pill's behavior surface; this note owns the four defects fixed in v0.93.2.