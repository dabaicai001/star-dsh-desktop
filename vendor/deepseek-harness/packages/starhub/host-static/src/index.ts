/**
 * @deepseek-ai/dsh-starhub-host-static — StarHub dist server over a webserver
 * prefix route (StarHub-local package, not upstream). It serves the standalone
 * React workbench window app at `/starhub-react` from the `starhub-window` Vite
 * build in repo `dist-starhub-react/`. Tools instance clicks load this entry in
 * the dsh shell's StarHub workbench panel (an in-shell same-origin iframe since
 * the de-Tauri M2 step 6; before that, an independent window/tab).
 *
 * A miss on a GET falls back to the prefix's index.html with 200; traversal
 * outside the dist root is 403; non-GET/HEAD is 405. The dist must use vite
 * base `/starhub-react/` so bare asset URLs do not escape to the dsh fallback.
 *
 * Location resolution order (first hit wins): the `windowDist` Config field
 * (what the M4 provisioning script writes into the profile patch), then
 * `STARHUB_WINDOW_DIST`, then the `dist/` shipped beside this module (how an
 * installed bundle carries its own workbench), then repo `dist-starhub-react`;
 * a missing dist fails loud at plugin load.
 *
 * @module @deepseek-ai/dsh-starhub-host-static
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'starhub-host-static'

/** Service required before the prefix route can be claimed. */
export const inject = ['webServer']

/**
 * Plugin config. `windowDist` is the deployment-varying dist location: the M4
 * provisioning script writes the absolute path of the dist it installed, so an
 * installed shell never depends on a StarHub checkout being present.
 */
export const Config: z<{ windowDist?: string }> = z.object({
  windowDist: z.string().default(''),
})

/** apply 收到的已解析配置。 */
export interface HostStaticConfig {
  windowDist?: string
}

/** URL prefix for the standalone React workbench window app (matches its vite base). */
export const WINDOW_PREFIX = '/starhub-react'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
}

/**
 * Locate the StarHub repo root by walking up from this module (built:
 * packages/starhub/host-static/lib/) to the directory holding
 * `vendor/deepseek-harness`.
 * @returns the absolute repo root, or undefined outside a StarHub checkout.
 */
function findRepoRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'vendor', 'deepseek-harness'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Resolve a served dist root for one prefix. An explicit source wins and is
 * strict; otherwise the package-local candidates are tried first, then repo
 * roots. The index must reference assets under the prefix's vite base so bare
 * URLs don't escape to the dsh fallback — a wrong-base index is rejected loud
 * (explicit) or skipped (candidate).
 * @param prefix - the vite base the dist must use (`/starhub` / `/starhub-react`).
 * @param envVar - env var or Config value naming an explicit dist root, or undefined.
 * @param fallbackDirs - repo-root-relative candidates in preference order.
 * @param emptyMessage - thrown when no qualifying dist exists at all.
 * @param localDirs - absolute package-local candidates, tried before the repo roots.
 * @returns the absolute dist root containing a matching index.html.
 * @throws when no qualifying dist exists.
 */
export function resolveDist(
  prefix: string, envVar: string | undefined, fallbackDirs: readonly string[], emptyMessage: string,
  localDirs: readonly string[] = [],
): string {
  const fromEnv = envVar !== undefined && envVar !== '' ? envVar : undefined
  const candidates: Array<{ dir: string; strict: boolean }> = fromEnv !== undefined
    ? [{ dir: resolve(fromEnv), strict: true }]
    : (() => {
      const repoRoot = findRepoRoot()
      const repo = repoRoot === undefined ? [] : fallbackDirs.map(d => join(repoRoot, d))
      return [...localDirs, ...repo].map(dir => ({ dir, strict: false }))
    })()
  for (const { dir: distRoot, strict } of candidates) {
    const distIndex = join(distRoot, 'index.html')
    if (!existsSync(distIndex)) continue
    if (readFileSync(distIndex, 'utf8').includes(`${prefix}/assets/`)) return distRoot
    if (strict) {
      throw new Error(
        `starhub-host-static: ${distIndex} 资源引用未带 ${prefix}/ 前缀;` +
        `请用对应 vite base 构建,或把 ${envVar} 指向正确 dist`,
      )
    }
  }
  throw new Error(emptyMessage)
}

/**
 * Package-local dist candidates shipped inside an installed bundle, nearest
 * ancestor first: a bundle carries the workbench dist beside this module so an
 * installed plugin needs no provisioning script to inject an absolute path.
 * @returns absolute candidate dist roots.
 */
function pluginLocalDirs(): string[] {
  const dirs: string[] = []
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 4; depth += 1) {
    dirs.push(join(dir, 'dist'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

/**
 * Resolve the standalone React window app dist root.
 *
 * Precedence: the `windowDist` Config field (provisioning-installed layout),
 * then `STARHUB_WINDOW_DIST`, then the dist shipped beside this module (bundle
 * install), then repo `dist-starhub-react`.
 * @param config - resolved plugin config.
 * @returns absolute dist root.
 */
export function resolveWindowDistRoot(config: HostStaticConfig = {}): string {
  const configured = config.windowDist?.trim() ?? ''
  return resolveDist(
    WINDOW_PREFIX,
    configured !== '' ? configured : process.env.STARHUB_WINDOW_DIST,
    ['dist-starhub-react'],
    'starhub-host-static: 未找到 StarHub React window dist(先构建 starhub-window,或用 STARHUB_WINDOW_DIST / windowDist 配置指定)',
    pluginLocalDirs(),
  )
}

/**
 * Serve one GET/HEAD request under a prefix from the dist root; a miss
 * falls back to index.html with 200 (SPA routing / embed query entries).
 * @param relPath - decoded pathname with the prefix already stripped.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory.
 * @param distIndex - absolute path of index.html inside distRoot.
 */
export async function serveStatic(
  relPath: string, res: ServerResponse, distRoot: string, distIndex: string,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, relPath)))
  // Traversal rejection mirrors frontend-static: resolve() emits backslash
  // paths on Windows, so the boundary check must use `sep`.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  const serveIndex = async (): Promise<void> => {
    const body = await readFile(distIndex)
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(body)
  }
  if (target === distRoot || target === distIndex) {
    await serveIndex()
    return
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    // Miss (ENOENT/EISDIR) falls back to index.html with 200 (SPA routing).
    await serveIndex()
  }
}

/**
 * Build a static-file handler for one prefix route: 405 for non-GET/HEAD,
 * SPA fallback to index.html, 403 on traversal outside the dist root.
 * @param prefix - the prefix the pathname is sliced by.
 * @param distRoot - absolute dist root.
 * @param distIndex - absolute index.html within the dist root.
 * @returns the node:http request handler.
 */
export function staticHandler(
  prefix: string, distRoot: string, distIndex: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* node:http always sets url on server requests. */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(decodeURIComponent(rawPath).slice(prefix.length), res, distRoot, distIndex)
  }
}

/**
 * Claim the React workbench prefix route. The workbench entry is a production
 * entry point (loaded by the shell's StarHub workbench panel iframe), so a
 * missing build prevents plugin startup instead of silently registering an
 * unusable fallback.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - resolved plugin config (dist location).
 */
export function apply(ctx: Context, config: HostStaticConfig = {}): void {
  const distRoot = resolveWindowDistRoot(config)
  const distIndex = join(distRoot, 'index.html')
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix', path: WINDOW_PREFIX, handler: staticHandler(WINDOW_PREFIX, distRoot, distIndex),
    }),
    'starhub-host-static: /starhub-react prefix route',
  )
}
