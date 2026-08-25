// 一次性:手动运行 typert generator(host face),为 7 个带 ./typert export 的包
// 生成 lib/typert.host.* + lib/typert.remote-client.* 产物。
// 背景:tsdown 的 typertPlugin 在本环境静默未落盘(上游 rc.2 构建缺口);
// manual generate 验证可行,这里等价于补跑该插件步骤。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceTypertGenerator } from '../packages/typert/generator/lib/types/index.js'

const root = process.cwd()
const gen = new WorkspaceTypertGenerator(root)
const all = gen.discover(['host'])
const pkgs = []
for (const c of all) {
  const f = join(root, c.root, 'package.json')
  const j = JSON.parse(readFileSync(f, 'utf8'))
  if (j.exports && j.exports['./typert']) pkgs.push({ name: c.package, root: c.root })
}

const artifacts = gen.generate(pkgs.map(p => p.name), ['host'])
let emitted = 0
for (const artifact of artifacts) {
  const pkg = pkgs.find(p => p.name === artifact.package)
  if (pkg === undefined) continue
  const out = join(root, pkg.root, 'lib')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `typert.host.js`), artifact.js)
  writeFileSync(join(out, `typert.host.d.ts`), artifact.dts)
  if (artifact.remote !== undefined) {
    writeFileSync(join(out, 'typert.remote-client.js'), artifact.remote.js)
    writeFileSync(join(out, 'typert.remote-client.d.ts'), artifact.remote.dts)
    writeFileSync(join(out, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap ?? '')
  }
  emitted++
  console.log(`emitted ${artifact.package}: host + remote-client`)
}
console.log(`done: ${emitted} packages`)