/**
 * StarHub × dsh desktop provisioning(去 Tauri 化 M4 第 1 步)。
 *
 * 覆盖两条线:
 * 1. `mergePatchRows` 的行级幂等合并——patch 文件同时是 dsh 设置体系的落盘
 *    目标,整体覆盖会把用户设置全重置(v0.122.0 回归),所以必须按 id 合并且
 *    保留 `!!js` 表达式与用户行;
 * 2. 端到端:假 vendor 树 + 假 sidecar + 假 dist 跑真脚本,断言 profile 三件套、
 *    十个包、资源落地、patch 受管行,以及**重跑幂等**(含用户行不被冲掉)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { mergePatchRows, rowsFromTemplate, validProfileName } from '../scripts/lib/provision-patch.mjs'

/** patch 直接引用但不在 CLI 闭包里的包(与 provisioning 同一份清单)。 */
const RUNTIME_HOSTED_PATCH_DEPS = ['dsh-tool-session-query']

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(repoRoot, 'scripts', 'provision-dsh.mjs')
const templatePath = join(repoRoot, 'vendor', 'deepseek-harness', 'examples', 'starhub-desktop', 'cordis.patch.yml')

const STARHUB_PACKAGES = [
  'client-nav', 'host-static', 'tool-context', 'bridge', 'tools',
  'approval-bridge', 'session-registry', 'domain-events', 'live-context', 'commit-message',
]

/** 受管行:provisioning 负责维护的 patch 行 id。 */
const MANAGED_IDS = ['webserver', 'starhub-bridge', 'starhub-host-static']

// ── mergePatchRows ────────────────────────────────────────────

test('mergePatchRows replaces a managed row config in place', () => {
  const existing = [
    '# 用户注释',
    '- id: webserver',
    '  config:',
    '    host: 0.0.0.0',
    '    port: 9999',
    '- id: something-else',
    '  config:',
    '    keep: true',
    '',
  ].join('\n')
  const merged = mergeRows(existing, [{ id: 'webserver', config: '    host: 127.0.0.1\n    port: 0' }])
  assert.match(merged, /# 用户注释/)
  assert.match(merged, /host: 127\.0\.0\.1/)
  assert.match(merged, /port: 0(?!\d)/)
  assert.doesNotMatch(merged, /0\.0\.0\.0/, '旧值被替换')
  assert.match(merged, /keep: true/, '非受管行原样保留')
})

test('mergePatchRows is idempotent', () => {
  const row = { id: 'webserver', config: '    host: 127.0.0.1\n    port: 0' }
  const first = mergeRows('', [row])
  const second = mergeRows(first, [row])
  const third = mergeRows(second, [row])
  assert.equal(second, first)
  assert.equal(third, first, '重跑不漂移')
})

test('mergePatchRows keeps !!js expressions and user rows untouched', () => {
  const existing = [
    '- id: settings',
    '  config:',
    '    path: !!js "process.env.DSH_SETTINGS_PATH ?? \'./.settings.yaml\'"',
    '- id: webserver',
    '  config:',
    '    host: 10.0.0.1',
    '',
  ].join('\n')
  const merged = mergeRows(existing, [{ id: 'webserver', config: '    host: 127.0.0.1' }])
  assert.match(merged, /path: !!js "process\.env\.DSH_SETTINGS_PATH/)
  assert.match(merged, /- id: settings/)
  assert.doesNotMatch(merged, /10\.0\.0\.1/)
})

test('mergePatchRows appends a row the file does not carry yet', () => {
  const merged = mergeRows('- id: webserver\n  config:\n    port: 1\n', [
    { id: 'starhub-bridge', config: '    sidecarCommand: ["/x/starhub-sidecar-rust"]' },
  ])
  assert.match(merged, /- id: starhub-bridge/)
  assert.match(merged, /sidecarCommand: \["\/x\/starhub-sidecar-rust"\]/)
  assert.match(merged, /- id: webserver/, '原有行仍在')
})

test('mergePatchRows drops the old config block entirely when the new one is shorter', () => {
  const existing = [
    '- id: starhub-bridge',
    '  config:',
    '    sidecarCommand: ["/old"]',
    '    healthTimeoutMs: 15000',
    '    extraKey: 1',
    '- id: tail',
    '  config:',
    '    keep: 1',
    '',
  ].join('\n')
  const merged = mergeRows(existing, [{ id: 'starhub-bridge', config: '    sidecarCommand: ["/new"]' }])
  assert.doesNotMatch(merged, /\/old/)
  assert.doesNotMatch(merged, /healthTimeoutMs/, '整块替换,不是逐键合并')
  assert.doesNotMatch(merged, /extraKey/)
  assert.match(merged, /\/new/)
  assert.match(merged, /keep: 1/, '后续行不受影响')
})

// ── 端到端 ───────────────────────────────────────────────────

/** 假 vendor 树 + 假 sidecar + 假 dist,返回路径表。 */
function buildFakeTree() {
  const root = mkdtempSync(join(tmpdir(), 'starhub-provision-'))
  const vendor = join(root, 'vendor')
  for (const name of STARHUB_PACKAGES) {
    const pkg = join(vendor, 'packages', 'starhub', name)
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), `${JSON.stringify({ name: `@deepseek-ai/dsh-starhub-${name}`, version: '0.0.1', type: 'module' }, undefined, 2)}\n`)
    writeFileSync(join(pkg, 'lib', 'index.js'), 'export function apply() {}\n')
    // 拷一份源码标记:证明只搬运行时段,src/ 不进去
    mkdirSync(join(pkg, 'src'), { recursive: true })
    writeFileSync(join(pkg, 'src', 'index.ts'), 'export {}\n')
  }
  const examples = join(vendor, 'examples', 'starhub-desktop')
  mkdirSync(examples, { recursive: true })
  writeFileSync(join(examples, 'cordis.patch.yml'), readFileSync(templatePath))
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const rust = join(bin, 'starhub-sidecar-rust')
  const go = join(bin, 'starhub-sidecar-go')
  writeFileSync(rust, 'fake-rust')
  writeFileSync(go, 'fake-go')
  // 打包运行时:闭包外的 patch 依赖住在这里(与 Rust RUNTIME_HOSTED_PATCH_DEPS 同源)
  for (const name of RUNTIME_HOSTED_PATCH_DEPS) {
    const pkg = join(root, 'runtime', 'node_modules', '@deepseek-ai', name)
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), `${JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.0.1', type: 'module' }, undefined, 2)}\n`)
    writeFileSync(join(pkg, 'lib', 'index.js'), 'export function apply() {}\n')
  }
  const dist = join(root, 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<html><script src="/starhub-react/assets/index.js"></script></html>')
  return { root, vendor, rust, go, dist }
}

function provision(tree, home, extraArgs = []) {
  return spawnSync(process.execPath, [
    scriptPath,
    '--home', home,
    '--vendor', tree.vendor,
    '--runtime', join(tree.root, 'runtime'),
    '--sidecar-rust', tree.rust,
    '--sidecar-go', tree.go,
    '--window-dist', tree.dist,
    ...extraArgs,
  ], { encoding: 'utf8' })
}

test('provisioning materializes the profile, the packages and the resources', (t) => {
  const tree = buildFakeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const home = join(tree.root, 'home')
  const result = provision(tree, home)
  assert.equal(result.status, 0, `脚本应成功:${result.stdout}\n${result.stderr}`)

  const profile = join(home, 'profiles', 'desktop')
  // 1. profile 三件套
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-profile-desktop')
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.ok(existsSync(join(profile, 'pnpm-workspace.yaml')), 'pnpm-workspace.yaml 落地')

  // 2. 十个包(只搬运行时段)
  for (const name of STARHUB_PACKAGES) {
    const pkg = join(profile, 'node_modules', '@deepseek-ai', `dsh-starhub-${name}`)
    assert.ok(existsSync(join(pkg, 'package.json')), `${name} manifest`)
    assert.ok(existsSync(join(pkg, 'lib', 'index.js')), `${name} lib`)
    assert.ok(!existsSync(join(pkg, 'src')), `${name} 不搬 src/(运行时段之外不入包)`)
  }
  // 2.1 闭包外的 patch 依赖也要落(不落就是 failed to import)
  for (const name of RUNTIME_HOSTED_PATCH_DEPS) {
    const pkg = join(profile, 'node_modules', '@deepseek-ai', name)
    assert.ok(existsSync(join(pkg, 'package.json')), `${name} manifest`)
    assert.ok(existsSync(join(pkg, 'lib', 'index.js')), `${name} lib`)
  }

  // 3. 资源
  const resources = join(home, 'starhub', 'resources')
  const goName = process.platform === 'win32' ? 'starhub-sidecar.exe' : 'starhub-sidecar'
  const rustName = process.platform === 'win32' ? 'starhub-sidecar-rust.exe' : 'starhub-sidecar-rust'
  assert.ok(existsSync(join(resources, rustName)), 'Rust sidecar 落地')
  assert.ok(existsSync(join(resources, goName)), 'Go sidecar 落地(名字必须与 GoSidecar::binary_name 一致)')
  assert.ok(existsSync(join(resources, 'starhub-react', 'index.html')))
  assert.ok(existsSync(join(home, 'starhub', 'provision.json')), '物化清单')

  // 4. patch 受管行
  const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: webserver/)
  assert.match(patch, /host: "?127\.0\.0\.1"?/)
  assert.match(patch, /port: 0(?!\d)/)
  assert.match(patch, new RegExp(`windowDist: '?${escapeRegExp(join(resources, 'starhub-react'))}'?`))
  assert.match(patch, /sidecarCommand:\n {10}- '.*starhub-sidecar-rust(\.exe)?'/)
  // sidecarCommand 必须是 YAML 数组:写成带引号的流序列会被解析成字符串,
  // 桥的 Config 校验直接报「expected array but got [...]」(冒烟实测踩到)
  assert.doesNotMatch(patch, /sidecarCommand: '/, '不能是带引号的流序列')
  // bridge 取代 sdk-jsonrpc-server(两者提供同一对服务,同时组合会 fail loud)
  assert.match(patch, /- id: starhub-bridge/)
  assert.doesNotMatch(patch, /^[ ]*- id: sdk-jsonrpc-server/m, 'desktop 组合不带 sdk-jsonrpc-server 行')
  assert.match(patch, /- id: starhub-tools/)
  assert.match(patch, /- id: client-nav/)
  // 每个受管行只能有一个 config 块(旧块必须被替换而不是摞叠)
  for (const id of ['webserver', 'starhub-bridge', 'starhub-host-static']) {
    const rowAt = patch.indexOf(`- id: ${id}`)
    assert.ok(rowAt >= 0, `${id} 行应在`)
    const rest = patch.slice(rowAt)
    const nextRow = rest.slice(1).search(/\n[ ]*- id: /)
    const block = nextRow === -1 ? rest : rest.slice(0, nextRow + 1)
    assert.equal((block.match(/^[ ]*config:[ \t]*$/gm) ?? []).length, 1, `${id} 只应有一个 config 块`)
  }
})

test('provisioning is idempotent and never clobbers user patch rows', (t) => {
  const tree = buildFakeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const home = join(tree.root, 'home')
  assert.equal(provision(tree, home).status, 0)
  const patchPath = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  const first = readFileSync(patchPath, 'utf8')

  // 用户经 GUI 设置面板写一行,再自己加一条注释
  const withUserRow = `${first}- id: my-own-plugin\n  config:\n    answerer: true\n`
  writeFileSync(patchPath, withUserRow)

  const second = provision(tree, home, ['--port', '4180'])
  assert.equal(second.status, 0, `重跑应成功:${second.stdout}\n${second.stderr}`)
  const merged = readFileSync(patchPath, 'utf8')
  assert.match(merged, /- id: my-own-plugin/, '用户行保留')
  assert.match(merged, /answerer: true/, '用户行内容保留')
  assert.match(merged, /port: 4180/, '受管行按新参数刷新')

  // 再跑一次同参数:受管行不再变化(用户行仍保留)
  assert.equal(provision(tree, home, ['--port', '4180']).status, 0)
  assert.equal(readFileSync(patchPath, 'utf8'), merged, '重跑不漂移')
})

test('provisioning fails loud when an input is missing', (t) => {
  const tree = buildFakeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const home = join(tree.root, 'home')
  const broken = { ...tree, go: join(tree.root, 'nope', 'starhub-sidecar-go') }
  const result = provision(broken, home)
  assert.notEqual(result.status, 0, '缺 sidecar-go 必须失败')
  assert.match(result.stderr, /sidecar-go 二进制缺失/)
  assert.ok(!existsSync(join(home, 'profiles', 'desktop')), '不物化半套')

  const noDist = { ...tree, dist: join(tree.root, 'no-dist') }
  const second = provision(noDist, home)
  assert.notEqual(second.status, 0)
  assert.match(second.stderr, /React 工作台 dist 缺失/)

  const missingPackage = { ...tree, vendor: join(tree.root, 'empty-vendor') }
  const third = provision(missingPackage, home)
  assert.notEqual(third.status, 0)
  assert.match(third.stderr, /StarHub 包目录缺失/)

  // 闭包外依赖没了也要 fail loud(否则启动时才 failed to import)
  const noRuntime = { ...tree, runtime: join(tree.root, 'no-runtime') }
  const fourth = provision(noRuntime, home, ['--runtime', join(tree.root, 'no-runtime')])
  assert.notEqual(fourth.status, 0)
  assert.match(fourth.stderr, /闭包外依赖缺失/)
})

test('provisioning rejects an illegal profile name and port', (t) => {
  const tree = buildFakeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const bad = provision(tree, join(tree.root, 'home'), ['--profile', 'a/b'])
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /--profile 非法/)

  const badPort = provision(tree, join(tree.root, 'home'), ['--port', '70000'])
  assert.notEqual(badPort.status, 0)
  assert.match(badPort.stderr, /--port 必须是/)
})

test('--dry-run prints the plan and writes nothing', (t) => {
  const tree = buildFakeTree()
  t.after(() => rmSync(tree.root, { recursive: true, force: true }))
  const home = join(tree.root, 'home')
  const result = provision(tree, home, ['--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--dry-run:不落盘/)
  assert.ok(!existsSync(join(home, 'profiles')), 'dry-run 不落盘')
})

function mergeRows(existing, rows) {
  return mergePatchRows(existing, rows)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('validProfileName mirrors the upstream whitelist', () => {
  for (const ok of ['desktop', 'web', 'sdk', 'my-profile']) {
    assert.equal(validProfileName(ok), true, ok)
  }
  for (const bad of ['', 'a/b', 'a\\b', '.', '..', 'node_modules']) {
    assert.equal(validProfileName(bad), false, JSON.stringify(bad))
  }
})

test('rowsFromTemplate only picks the managed rows', () => {
  const rendered = [
    '# 注释',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '- id: permission',
    '  config:',
    '    presets: {}',
    '- insert:',
    '    - id: starhub-bridge',
    '      name: x',
    '      config:',
    '        sidecarCommand: ["/a"]',
    '',
  ].join('\n')
  const rows = rowsFromTemplate(rendered, ['webserver', 'starhub-bridge'])
  assert.deepEqual(rows.map(row => row.id), ['webserver', 'starhub-bridge'])
  assert.match(rows[0].config, /host: 127\.0\.0\.1/)
  // insert 块里的行(id 缩进 4、config 缩进 6)也要能取到 config
  assert.match(rows[1].config, /sidecarCommand/)
})
