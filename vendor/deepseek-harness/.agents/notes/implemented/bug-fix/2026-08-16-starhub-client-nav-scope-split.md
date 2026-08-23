# Agent Note: StarHub client-nav splits stores by slot scope and rides the hooks compartment

Status: implemented

English | [中文](2026-08-16-starhub-client-nav-scope-split.zh.md)

## Problem

`packages/starhub/client-nav` (StarHub-local, not upstream) registered four slot entries sharing one store handle: `sidebar.navigation` and `shell.overlay` are `root` scope, while `workspace` and `details.workspace` are `session-maybe`. The store registry pins a handle's scope on first mount (one handle, one scope), so a composition whose layout plugin declares the workspace slots threw `store handle mounted under "workspace" (scope "session-maybe") is already mounted under scope "root"` at boot and the whole plugin failed to load — the StarHub web GUI rendered only "Failed to load plugins". Compositions without the workspace slots (older ui-layout builds) never hit the throw, which masked the defect.

Splitting the handle fixed the boot crash but exposed a second renderer rule: `scoped-slots.tsx` mounts a registration's declared store only when the session-maybe seat has a session (`scope === 'session-maybe' && info?.sessionId === undefined` skips `storeOf`), so the no-session workspace seat received no `useStore`/`actions` and crashed rendering with `useStore is not a function`. State shared across scopes therefore cannot ride registration stores at all for these seats.

## Decision

`client-nav` keeps exactly one registration-declared store: `createStarHubNavStore()` (root scope) shared by `sidebar.navigation` and `shell.overlay`. Everything the session-maybe seats share — the asset list (`get_assets` result + loading/error) and the cross-scope tool selection (current subcategory + open asset instance) — lives in apply-owned bare snapshot sources created in the plugin's `apply` (`createStarHubAssets`, `createToolSelectionBridge`) and handed to every registration through the inject `hooks` compartment, arriving as bound `useAssets`/`useSelection` selector hooks; writes go through injected callbacks (`openAsset`, `closeAsset`, `selectSubcategory`, `refreshAssets`). This is the `ui-agent-preset` controller precedent extended to two holders. `openAsset` derives the instance route prefix per asset (`routePrefixForAsset` — a PostgreSQL/Redis asset must not inherit the database subcategory's `/db/mysql` prefix) and generates the instance id once, so overlay rerenders never rebuild the iframe src. The tool-context settings sync writes the full four-field patch with empty-string clearing so a deselected asset cannot linger as stale AI context. The [session-scope architecture note](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md) owns session-maybe adoption semantics; this note owns only the client-nav state topology.

## Alternatives considered

**Two store handles, one per scope.** Fixes the boot throw but not the no-session crash: the workspace seat still renders without a session, where the framework withholds the store pair. It also duplicates every cross-scope write (nav click must reach the workspace list and the overlay), reintroducing the coupling the bridge now owns.

**Let the no-session seat render without the list.** Degrading `workspace` to a placeholder until a session exists contradicts the StarHub plan (the tool workspace is the no-session landing surface) and still leaves the overlay reading selection across scopes.

**Hoist all state into the root-scope nav store.** Overlay and nav share root scope, but the workspace seats are session-maybe; a root store handle mounted under them trips the same one-handle-one-scope throw.

## Consequences

The StarHub web GUI boots on compositions that declare the workspace slots (the 3086 test instance renders the tool navigation, the workspace column guide, and zero console errors under a headless check), and the no-session landing shows the asset workspace instead of crashing. The cost is that client-nav's shared state no longer follows the registration-store happy path: every cross-scope field flows through two apply-owned sources and their injected callbacks, which tests must stub explicitly (`starhub-shell-state` plus the workspace spec, 18 tests). The asset list refetches on mount and on every subcategory switch, trading a cache for freshness against settings-side asset edits.
