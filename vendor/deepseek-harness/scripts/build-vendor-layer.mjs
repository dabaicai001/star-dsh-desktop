// 批量构建 vendored 框架层(vendor/*)的 tsdown 产物。
// 单独跑各包的 tsdown.config(绕开全 workspace 构建的 api-remotes 阻塞)。
// 顺序:cosmokit → schemastery → cordis → loader → include → group → timer → hmr → logger-console
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const order = ['cosmokit', 'schemastery', 'cordis', 'loader', 'include', 'group', 'timer', 'hmr', 'logger-console']

for (const v of order) {
  const cfg = join(root, 'vendor', v, 'tsdown.config.ts')
  if (!existsSync(cfg)) {
    console.log(`${v}: no tsdown.config, skip`)
    continue
  }
  console.log(`--- ${v} ---`)
  try {
    const out = execSync(`pnpm exec tsdown --config vendor/${v}/tsdown.config.ts`, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const mjs = existsSync(join(root, 'vendor', v, 'lib', 'index.mjs')) || existsSync(join(root, 'vendor', v, 'lib', 'index.js'))
    console.log(`${v}: built, index.mjs/js exist = ${mjs}`)
  } catch (e) {
    const msg = (e.stderr?.toString?.() ?? e.message ?? '').toString().split('\n').slice(0, 8).join('\n')
    console.log(`${v}: FAILED\n${msg}`)
  }
}