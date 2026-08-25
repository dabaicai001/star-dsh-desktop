// StarHub host 包:package.json exports/main 指向 tsc 直出产物(lib/types/*.js),
// 不再依赖 tsdown 转换(lib/index.js 由 bundling 产物,tsc 只出 lib/types)。
// 覆盖 6 个 host 包:session-registry / memory-context / live-context / memory-sink /
// domain-events / approval-bridge(commit-message / host-static / tool-context / tools 检查同类)。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pkgs = [
  'session-registry', 'memory-context', 'live-context', 'memory-sink',
  'domain-events', 'approval-bridge', 'commit-message', 'host-static',
  'tool-context', 'tools',
]

for (const p of pkgs) {
  const f = join(root, 'packages/starhub', p, 'package.json')
  if (!existsSync(f)) continue
  const j = JSON.parse(readFileSync(f, 'utf8'))
  let changed = false
  // main: lib/index.js → lib/types/index.js
  if (typeof j.main === 'string' && j.main.startsWith('lib/') && !j.main.startsWith('lib/types/')) {
    j.main = j.main.replace(/^lib\//, 'lib/types/')
    changed = true
  }
  // exports default/types: ./lib/X.js → ./lib/types/X.js
  for (const key of Object.keys(j.exports ?? {})) {
    const e = j.exports[key]
    if (typeof e === 'object' && e !== null) {
      for (const cond of ['default', 'types']) {
        if (typeof e[cond] === 'string' && e[cond].startsWith('./lib/') && !e[cond].startsWith('./lib/types/')) {
          e[cond] = e[cond].replace('^./lib/', './lib/types/').replace(/\.\/lib\//, './lib/types/')
          changed = true
        }
      }
    }
  }
  // files: lib/index.js → lib/types/index.js 已在(types/**)
  if (changed) {
    writeFileSync(f, JSON.stringify(j, null, 2) + '\n')
    console.log(`${p}: exports/main → lib/types/*`)
  } else {
    console.log(`${p}: no change`)
  }
}