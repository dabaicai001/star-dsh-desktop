# Agent Note: DiffBlock Draws a Two-Column Before/After Comparison

Status: implemented

## Problem

The file-mutation diff card rendered the removed block and the added block as
one stacked list — reading an edit meant mentally subtracting the `-` rows from
the `+` rows. StarHub's review asked for the conversation Edit card to show
before and after side by side, with visible `+`/`-` markers and background
tints, one shared scroll for both columns.

## Decision

`DiffBlock` (ui-primitives) now renders each hunk as a two-column grid: column
heads `− 修改前` / `+ 修改后`, left cells on error tints, right cells on
success tints, unchanged lines paired across both. Alignment runs a head/tail
trim followed by a bounded LCS over the differing middle (`Int32Array`,
~250k-cell cap above which the sides stack unpaired instead of allocating),
then folds adjacent pure-del/pure-add runs into positional pairs so a
replacement reads row-by-row rather than as two disjoint blocks.
ONE scroller owns both columns: vertical sync is structural, horizontal
overflow of either column scrolls the sheet; the sticky heads ride along.
File path headers and same-file hunk gaps span both columns; the collapsed
height cap scrolls behind the expand control instead of slicing rows.
The `+A -R · N files` footer and the copied text keep computing from the
LEGACY stacked flattening verbatim, so totals and clipboard bytes are
unchanged for every consumer (chat rows, details panel, TUI parity) — pairing
is presentation only. The public props (`diffs/maxLines/className`) did not
change.

## Alternatives considered

**Pair without alignment (split sheets: all-old left, all-new right).** No
row correspondence at all — after three inserted lines every row misleads.

**A new primitive beside DiffBlock.** Every consumer would pick between two
diff surfaces that drift independently; changing the shared one reaches all
call sites at once, and none passes more than the same three props.

**Character-level diff or per-word highlight inside changed rows.** Out of
scope for a transcript card whose inputs are already whole-file hunks; row
alignment carries the review need.

## Consequences

Slot count shifts only for replacements: a paired del/add row replaces two
stacked rows, so long hunks render shorter overall; creates, deletions, and
context render the same line count as before. Column tint carries direction
on top of position, so a changed region reads without counting prefix
characters; tests assert structure through `data-col`/`data-state` rather
than class names. The LCS pass adds one bounded allocation per differing
middle — capped work, and the fallback path keeps pathological rewrites
responsive without pairing.

## Testing

`packages/client/ui-primitives/tests/diff-block.client.spec.tsx` re-pins the
two-column semantics (head labels, same-row del/add pairing, context pairing,
create/delete extremes with empty placeholders, spanning headers/gaps,
footer/copy parity against the legacy format, cap/expand). The web
built-boot snapshot's `[data-diff]` + footer assertions hold unchanged.
