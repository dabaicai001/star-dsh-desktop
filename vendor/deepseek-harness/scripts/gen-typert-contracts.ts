/**
 * Bootstrap Typert contract generation from SOURCE (pre-tsc phase).
 *
 * The owner packages' `./remote` subpath exports point at generated
 * `lib/typert.remote-client.d.ts` artifacts, and `tsconfig.base.json` maps
 * many package names — including `@deepseek-ai/dsh-client-*` / `api-remotes`
 * faces — straight to `src/`. A clean checkout therefore type-checks sources
 * that import a package's slash-remote subpath before any generator has ever
 * run: the root tsc phases fail with TS2307 exactly as a fresh CI checkout did.
 *
 * Upstream's ordered-build note (2026-08-08) lets Host tsdown produce the
 * contracts between the two tsc phases; that is not enough here because this
 * workspace's base-path surface reaches the generated specifiers already in
 * the Host program. Generating the artifacts unconditionally BEFORE every
 * `build:lib:host` (hence before `typecheck`, which runs it first) keeps
 * stale-artifact masking impossible: each run rewrites the full face set,
 * so a retired `@Remote` method drops its contract in the same run.
 *
 * Must run through tsx: it imports the generator's TypeScript source with no
 * built `lib/` present.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
// Relative .ts import on purpose: the generator's own lib/ may not exist yet.
import { WorkspaceTypertGenerator } from '../packages/typert/generator/src/workspace.ts'
import type { WorkspaceEmitResult } from '../packages/typert/generator/src/workspace.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

/** Files emitted beside a host contract when the face carries Remote methods. */
const REMOTE_TRIO = [
  'typert.remote-client.js',
  'typert.remote-client.d.ts',
  'typert.remote-client.d.ts.map',
] as const

/** Write one artifact into its owning package's `lib/` (same layout as the tsdown plugin). */
function emitArtifact(root: string, artifact: WorkspaceEmitResult): void {
  const output = join(root, artifact.packageRoot, 'lib')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, `typert.${artifact.face}.js`), artifact.js)
  writeFileSync(join(output, `typert.${artifact.face}.d.ts`), artifact.dts)
  if (artifact.remote !== undefined) {
    writeFileSync(join(output, 'typert.remote-client.js'), artifact.remote.js)
    writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
    writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
    return
  }
  // Host face without Remote methods must not keep a stale contract from an
  // earlier generation: the exports validator would rightly reject the mix.
  if (artifact.face === 'host') {
    for (const file of REMOTE_TRIO) rmSync(join(output, file), { force: true })
  }
}

/** True when a manifest publishes at least one Typert face subpath (mirrors the tsdown plugin's filter). */
function hasTypertExport(exportsField: unknown): boolean {
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return false
  return Object.hasOwn(exportsField, './typert')
    || Object.hasOwn(exportsField, './client/typert')
    || Object.hasOwn(exportsField, './remote')
}

function main(): void {
  const generator = new WorkspaceTypertGenerator(REPO_ROOT)
  // Same two-step as the plugin's workspace mode: discover, keep only
  // manifests that publish a Typert face, then generate that exact subset —
  // validateExport rejects any other package for lacking the export.
  const packages = generator.discover(['host'])
    .filter(candidate => hasTypertExport(
      JSON.parse(readFileSync(join(REPO_ROOT, candidate.root, 'package.json'), 'utf8') as string).exports,
    ))
    .map(candidate => candidate.package)
  if (packages.length === 0) {
    console.log('gen-typert-contracts: no Typert contributors found')
    return
  }
  const artifacts = generator.generate(packages, ['host'])
  let remotes = 0
  for (const artifact of artifacts) {
    emitArtifact(REPO_ROOT, artifact)
    if (artifact.remote !== undefined) remotes++
  }
  console.log(`gen-typert-contracts: ${artifacts.length} face artifact(s), ${remotes} remote contract(s)`)
}

main()
