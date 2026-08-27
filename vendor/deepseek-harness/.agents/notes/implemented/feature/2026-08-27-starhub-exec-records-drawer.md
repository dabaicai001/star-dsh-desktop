# Agent Note: StarHub Exec Records Move From Floating Panels to the Tools Drawer

Status: implemented

## Problem

The v0.99.0 exec panel stacked one fixed-position card per SSH session connection
in the bottom-right corner of the dsh shell. Three defects accumulated: the
drag-to-reorder gesture was unreliable by construction (the swap fired only when
the cursor entered another panel's rectangle, and each reorder MOVED a DOM node
that Chrome had granted pointer capture to, implicitly releasing capture and
dropping every later move event); many simultaneous sessions overflowed the
corner with cards users could not park anywhere else; and the listener lived in
a component that remounts, so subscription lifecycle followed mount order.

## Decision

Silent-exec output lives in the right-side tools drawer now. A new「执行」pill
(`ExecDrawerButton`, order 45, next to the file-tree pill on
`conversation.session.header.actions`) toggles `viewOpen` on an apply-owned
`execRecords` bridge; the drawer seat (`StarHubToolWorkspace`) renders
`ExecRecordList` when open — one collapsed row per session connection (badge,
command, time), click toggles the full output, the list scrolls vertically,
「清空」wipes the records. The bridge keeps at most 50 records, dedupes per
`dsh:`-prefixed sessionId (latest first), and ignores non-AI sessions. The
`ssh:exec-done` Tauri subscription moved up into `apply` as a plugin-lifetime
`ctx.effect`, so collection no longer depends on any component being mounted.
The `shell.overlay` BastionExecPanel seat, its component, styles, and spec are
removed. Opening one view closes the other (file-tree vs exec), and closing
the drawer resets both flags through the same combined `closeTools`.

## Alternatives considered

**Repair the floating stack's drag.** Even with window-level move listeners
and midpoint-swap math, N fixed cards stay an unbounded overlay competing with
real UI for screen space; the drawer reuses an established surface instead.

**A per-session badge pinned to the conversation composer.** No scrollable
home for history, and it couples a root-scope data source to a session-scoped
seat without adding value over the header pill.

## Consequences

The drag feature is gone deliberately — replace with it nothing: the drawer
ordering is newest-first and stable. AI silent execution across MANY bound
assets stays observable in one place. Components became pure presentations
(records enter only through props/injected callbacks), which is what the
client discipline wants anyway; total record output remains capped at the
backend's 4000-character truncation per event.

## Related

- [StarHub File Viewer Overlay](../feature/2026-08-21-starhub-file-viewer-overlay.md) — the bare-source bridge + drawer-seat pattern this reuses.
