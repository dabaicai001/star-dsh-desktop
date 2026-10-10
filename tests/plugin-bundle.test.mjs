/**
 * StarHub 纯插件化(bundle 形态)组装逻辑单测。
 *
 * 守的是三条**安装能不能成功**的硬约束(每一条都踩过或差点踩到,见
 * docs/纯插件化-适配清单.md):
 *
 * 1. 包必须**自包含**:不能有 dependencies / peerDependencies——本地目录安装是
 *    link,依赖不会被装;而 `@deepseek-ai/dsh*` 的 peer 会被兼容门判不兼容;
 * 2. 行名必须落在 exports 上,且**有一个裸包名行**承载客户端半边——dsh 的
 *    client-modules 只把「裸包名」行当客户端行(`exactPackageSpecifier` 对子路径
 *    返回 undefined),客户端半边挂在纯子路径行上会静默不加载;
 * 3. 行的 id 与 provisioning 那份模板一致——id 是公共标识,用户覆盖与插件页
 *    开关都按 id 认。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { PLUGINS, CLIENT_PLUGIN, ICON_SVG, renderManifest, renderPatch } = await import(
  '../scripts/build-plugin-bundle.mjs'
)
const require = createRequire(import.meta.url)

const PACKAGE_NAME = '@starhub/dsh-plugin'
const VERSION = '1.2.3'

/** 读 provisioning 那份模板里的行 id(单一事实来源比对)。
 *  模板含未填的 `@@STARHUB_SIDECAR_COMMAND@@` 占位,YAML 解析必然失败,所以按行取 id。
 */
function templateRowIds() {
  const text = readFileSync(
    join(repoRoot, 'vendor', 'deepseek-harness', 'examples', 'starhub-desktop', 'cordis.patch.yml'),
    'utf8',
  )
  return [...text.matchAll(/^\s*- id: (\S+)$/gm)].map(match => match[1])
}

test('bundle 清单自包含:无 dependencies / peerDependencies / scripts', () => {
  const manifest = renderManifest(PACKAGE_NAME, VERSION)
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.scripts, undefined)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

test('客户端半边挂在裸包名行上(子路径行不会被当作客户端行)', () => {
  const manifest = renderManifest(PACKAGE_NAME, VERSION)
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], `./${CLIENT_PLUGIN}/lib/client.js`)
  assert.equal(manifest.exports['.'], `./${CLIENT_PLUGIN}/lib/index.js`)

  const document = require(join(repoRoot, 'vendor', 'deepseek-harness', 'node_modules', 'js-yaml'))
    .load(renderPatch(PACKAGE_NAME))
  const rows = document.flatMap(entry => entry.insert)
  const bare = rows.filter(row => row.name === PACKAGE_NAME)
  assert.equal(bare.length, 1, '必须恰好有一个裸包名行')
  assert.equal(bare[0].id, 'client-nav')
})

test('每个 insert 行都有对应 exports / package.json(缺一个就 failed to import)', () => {
  const manifest = renderManifest(PACKAGE_NAME, VERSION)
  const document = require(join(repoRoot, 'vendor', 'deepseek-harness', 'node_modules', 'js-yaml'))
    .load(renderPatch(PACKAGE_NAME))
  const rows = document.flatMap(entry => entry.insert)
  assert.equal(rows.length, PLUGINS.length)
  for (const row of rows) {
    const subpath = row.name === PACKAGE_NAME ? '.' : `./${row.name.slice(PACKAGE_NAME.length + 1)}`
    const target = manifest.exports[subpath]
    assert.ok(typeof target === 'string', `行 ${row.id} 缺 exports["${subpath}"]`)
    assert.ok(target.startsWith('./') && target.endsWith('.js'))
    // 子路径插件各自带一份 manifest(展示元数据与解析都按最近祖先 manifest 找)
    if (subpath !== '.') assert.ok(manifest.exports[`${subpath}/package.json`] !== undefined)
  }
})

test('bundle 是纯 insert:不覆盖 webserver / permission / session-query-sqlite 等上游行', () => {
  const document = require(join(repoRoot, 'vendor', 'deepseek-harness', 'node_modules', 'js-yaml'))
    .load(renderPatch(PACKAGE_NAME))
  assert.equal(document.length, 1)
  assert.ok(Array.isArray(document[0].insert))
  assert.equal(document[0].id, undefined)
})

test('行 id 与 provisioning 模板一致(id 是用户覆盖与开关的公共标识)', () => {
  const document = require(join(repoRoot, 'vendor', 'deepseek-harness', 'node_modules', 'js-yaml'))
    .load(renderPatch(PACKAGE_NAME))
  const ids = document.flatMap(entry => entry.insert).map(row => row.id)
  for (const id of ids) {
    // tool-session-query / mcp-client 是随 dsh 出货的行,不进 bundle(避免解析不到)
    assert.ok(templateRowIds().includes(id), `${id} 不在 provisioning 模板里`)
  }
  assert.deepEqual(ids, PLUGINS.map(plugin => plugin.row))
})

test('图标是内嵌 SVG 且远小于 256 KiB 上限', () => {
  assert.ok(ICON_SVG.startsWith('<svg'))
  // 只允许内联形状:不得引用外部图片/样式(命名空间声明里的 http:// 不算引用)
  assert.ok(!/\b(?:href|src)\s*=/.test(ICON_SVG), '图标不得引用外部资源')
  assert.ok(!/url\(\s*['"]?https?:/i.test(ICON_SVG), '图标不得引用外部样式')
  assert.ok(!/<image\b/i.test(ICON_SVG), '图标不得内嵌位图')
  assert.ok(Buffer.byteLength(ICON_SVG) < 256 * 1024)
})
