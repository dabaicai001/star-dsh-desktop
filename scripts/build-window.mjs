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
import { cp, mkdir, rm } from 'node:fs/promises'
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

// 先清再拷:vite 的 outDir 每次干净,但这两个落地目录不会——不清就会一代代
// 累积带 hash 的 assets 与 sourcemap(v0.129.0 实测 staging 涨到 443 MB / 486 个文件,
// 而单次产物只有 21 MB),provisioning 会把这个目录整个拷进安装包。
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(appDist, target, { recursive: true })
console.log(`starhub-window staged at ${target}`)

if (runtimeTarget !== undefined && runtimeTarget !== '' && resolve(runtimeTarget) !== target) {
  await rm(runtimeTarget, { recursive: true, force: true })
  await mkdir(runtimeTarget, { recursive: true })
  await cp(appDist, runtimeTarget, { recursive: true })
  console.log(`starhub-window synced to runtime at ${runtimeTarget}`)
}
