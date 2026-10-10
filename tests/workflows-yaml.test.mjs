/**
 * GitHub Actions 工作流文件必须是合法 YAML,而且真的能起 job。
 *
 * 这条测试是一次真实事故的护栏:M4 第 3 步把 `linux-compat.yml` 换成 `ci.yml`、
 * 重写 `release.yml` 时,步骤名写成 `- name: Smoke: provisioning + host boot`——
 * 值里那个 `: `(冒号加空格)在 YAML 里是映射条目分隔符,整份文件因此非法。
 * GitHub 加载不了工作流文件,于是**一个 job 都不起、秒级 failure**,只留一句
 * 「This run likely failed because of a workflow file issue」。本地从不跑 CI,
 * 所以从 2026-10-09 到发现为止,CI 门和发布链一次都没真正跑过——所有绿都是
 * 本机单测的绿。
 *
 * 两个断言各自钉住一半:
 * 1. `js-yaml` 能解析(解析器从 vendor 树取,不给仓库根加依赖);
 * 2. 没有任何**裸标量**的值里含 `: `——这是那类事故的直接形态,比「等 YAML
 *    解析器报错」更早、更具体地指出该给哪一行加引号。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflowsDir = join(repoRoot, '.github', 'workflows')

/** 与 provisioning 同一套解析器解析顺序:仓库根 → vendor 树。 */
function loadYamlParser() {
  const candidates = [
    join(repoRoot, 'node_modules', 'js-yaml'),
    join(repoRoot, 'vendor', 'deepseek-harness', 'node_modules', 'js-yaml'),
  ]
  for (const candidate of candidates) {
    try {
      return createRequire(join(candidate, 'package.json'))('js-yaml')
    } catch {
      // 换个候选
    }
  }
  return null
}

const workflowFiles = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort()

test('工作流目录里至少有一个工作流文件', () => {
  assert.ok(workflowFiles.length > 0, `${workflowsDir} 下没有 .yml / .yaml`)
})

test('每个工作流文件都是合法 YAML 且声明了至少一个 job', () => {
  const yaml = loadYamlParser()
  assert.ok(yaml, '找不到 js-yaml(仓库根与 vendor 树都没有)——本测试需要它才能跑')
  for (const name of workflowFiles) {
    const text = readFileSync(join(workflowsDir, name), 'utf8')
    let doc
    try {
      doc = yaml.load(text)
    } catch (err) {
      assert.fail(`${name} 不是合法 YAML:${err.reason ?? err.message}(第 ${(err.mark?.line ?? 0) + 1} 行)`)
    }
    assert.ok(doc && typeof doc === 'object', `${name} 解析结果不是映射`)
    assert.ok(doc.jobs && Object.keys(doc.jobs).length > 0, `${name} 没有声明任何 job`)
  }
})

test('没有裸标量的值里含 ": "(那会让整份工作流变成非法 YAML)', () => {
  // `- name: Smoke: provisioning + host boot` 就是这条要抓的形态:值里的
  // `: ` 被当成映射条目分隔符,YAML 直接报 bad indentation。
  const offenders = []
  for (const name of workflowFiles) {
    const lines = readFileSync(join(workflowsDir, name), 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      const match = /^(\s*(?:-\s+)?)([A-Za-z_][\w.-]*):\s+(.+)$/.exec(line)
      if (!match) return
      const value = match[3]
      if (value.startsWith("'") || value.startsWith('"')) return
      if (value.startsWith('|') || value.startsWith('>')) return
      if (/: /.test(value)) offenders.push(`${name}:${index + 1}  ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], `这些行的裸标量值里含 ": ",需要加引号:\n${offenders.join('\n')}`)
})
