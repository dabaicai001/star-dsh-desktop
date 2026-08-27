# Agent Note: Typert Contract Bootstrap From Source

Status: implemented

## Problem

This StarHub fork vendored a harness snapshot whose `tsconfig.base.json` maps
many package names straight to `src/` — including every
`@deepseek-ai/dsh-client-*` face and `@deepseek-ai/dsh-api-remotes` — while the
`./remote` subpath of seven owner packages resolves only to generated
`lib/typert.remote-client.d.ts` artifacts. On a clean checkout the FIRST tsc
phase therefore already type-checks sources importing slash-remote subpaths,
and dies with TS2307 before any generator could run. The ordered phases of
[the api-remotes build note](../../process/2026-08-08-api-remotes-generated-contract-build.md)
(host tsc → host tsdown → client tsc) assume Host tsdown is the first consumer
of those specifiers, which this paths surface breaks; local trees never noticed
because residual `lib/` outputs from earlier builds masked it. This exact
failure shipped as the StarHub v0.99.x release-blocking CI error.

## Decision

`build:lib:host` now begins with `gen:typert`
(`scripts/gen-typert-contracts.ts`, run through tsx): the generator's SOURCE
entry analyzes `faces: ['host']`, filters discovered packages through the same
`hasTypertExport` check the tsdown plugin applies, and writes each artifact set
(`typert.host.*` plus the `typert.remote-client.*` trio) directly into the
owning package's gitignored `lib/`. It runs unconditionally on every host lib
phase — including inside `typecheck` and `lint`, which both prepend
`build:lib:host` — and rewrites the full face set each time, so a retired
`@Remote` method drops its stale contract in the same run instead of masking a
dependency break behind an old artifact.

## Alternatives considered

**Run generation once at install (postinstall).** A fresh clone that skips or
fails the hook regresses silently; per-phase regeneration keeps the guarantee
at the point of use.

**Add `/remote` paths entries pointing at source.** The contracts are derived
from decorators across multiple packages, not single source files; no static
mapping can stand in for the generated projection.

**Revert the base paths to point at `lib/types`.** That rescopes how every
package in the fork resolves, and contradicts this workspace's intentional
source-plane test setup; far wider blast radius than the one missing artifact
class.

## Consequences

A clean StarHub checkout builds end to end again (`build:lib`, then
`package-dsh-runtime` and the release flow, which call it). The Host-tsdown
Typert pass still runs afterwards and re-emits everything workspace-wide, so
the bootstrap is a pre-pass, not a second authority. The 2026-08-08 ordering
note remains accurate for upstream shape; this fork adds one earlier stage.
Cost: each host phase pays one full generator analysis (~seconds), even when
artifacts exist.

## Related

- [Ordered Build for API Remotes Generated Contracts](../../process/2026-08-08-api-remotes-generated-contract-build.md) — partial supersession context: its phase order stands, with bootstrap prepended here.
