/**
 * Build the standalone StarHub React workbench window app and stage its dist
 * at the repo-root `dist-starhub-react/` where starhub-host-static serves the
 * `/starhub-react` prefix (and where provisioning copies it into
 * `<dsh-home>/starhub/resources/`).
 *
 * The app lives in the vendored harness workspace
 * (`vendor/deepseek-harness/apps/starhub-window`, package `@deepseek-ai/starhub-window`);
 * its Vite build emits to `dist/` with the `/starhub-react/` base. We copy that
 * into the repo-root staging dir so the host-static fallback and the packaged
 * shell both resolve it without an env var.
 */
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = join(root, 'vendor', 'deepseek-harness')
const appDist = join(harnessRoot, 'apps', 'starhub-window', 'dist')
const target = join(root, 'dist-starhub-react')
const runtimeTarget = process.env.STARHUB_WINDOW_DIST

// Pnpm must be run from the harness workspace root for --filter to resolve.
execSync('pnpm --filter @deepseek-ai/starhub-window build', {
  cwd: harnessRoot,
  stdio: 'inherit',
})

await mkdir(target, { recursive: true })
await cp(appDist, target, { recursive: true })
console.log(`starhub-window staged at ${target}`)

if (runtimeTarget !== undefined && runtimeTarget !== '' && resolve(runtimeTarget) !== target) {
  await mkdir(runtimeTarget, { recursive: true })
  await cp(appDist, runtimeTarget, { recursive: true })
  console.log(`starhub-window synced to runtime at ${runtimeTarget}`)
}
