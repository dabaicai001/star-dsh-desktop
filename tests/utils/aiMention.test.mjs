import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../../legacy-core/utils/aiMention.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const mentionModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const {
  matchMention,
  agentHandle,
  extractMentionedHandles,
  filterMentionedAgents,
  extractHashTokens,
  extractMentionScopes,
  workspacePrefix,
  tokenSafeName,
  assetMentionToken,
  assetSummary,
  filterMentionedAssets
} = mentionModule

function makeAsset(overrides) {
  return {
    id: 'a1',
    type: 'ssh',
    name: '测试服务器',
    groupId: null,
    config: {},
    keyId: null,
    tags: [],
    favorite: false,
    lastUsedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

test('matchMention 只在行首或空白后的尾部 @/# 触发', () => {
  assert.equal(matchMention('普通文本'), null)
  assert.equal(matchMention('邮箱 a@b'), null)
  const atStart = matchMention('@')
  assert.deepEqual(atStart, { index: 0, leading: '', trigger: '@', query: '' })
  const withQuery = matchMention('帮我看看 @Ops-A')
  assert.deepEqual(withQuery, { index: 4, leading: ' ', trigger: '@', query: 'Ops-A' })
  const hash = matchMention('绑定 #SSH-测试')
  assert.deepEqual(hash, { index: 2, leading: ' ', trigger: '#', query: 'SSH-测试' })
  // 尾部已有空白 → 不再处于 mention 输入态
  assert.equal(matchMention('hello @agent '), null)
})

test('agentHandle 把名称空白折叠为短横线', () => {
  assert.equal(agentHandle({ name: 'Ops Agent' }), 'Ops-Agent')
  assert.equal(agentHandle({ name: '  多  空格  ' }), '多-空格')
})

test('extractMentionedHandles 小写去重', () => {
  assert.deepEqual(extractMentionedHandles('@Ops-A 和 @ops-a 还有 @DBA'), ['ops-a', 'dba'])
  assert.deepEqual(extractMentionedHandles('没有提及'), [])
})

test('filterMentionedAgents 按句柄过滤且保持顺序', () => {
  const agents = [{ name: 'Ops Agent' }, { name: 'DBA' }, { name: 'Watcher' }]
  assert.deepEqual(filterMentionedAgents(agents, '@dba 看下'), [{ name: 'DBA' }])
  assert.deepEqual(filterMentionedAgents(agents, ''), [])
})

test('extractHashTokens 带 # 前缀小写去重', () => {
  assert.deepEqual(extractHashTokens('#SSH #ssh-测试 服务器'), ['#ssh', '#ssh-测试'])
})

test('extractMentionScopes 识别模块 token 与中文别名', () => {
  assert.deepEqual(extractMentionScopes('#SSH #docker 看看'), ['ssh', 'docker'])
  assert.deepEqual(extractMentionScopes('#本机 检查'), ['local'])
  // 模块 token 必须完整(后随空白或结尾),#SSH-xxx 是资产 token 不算模块
  assert.deepEqual(extractMentionScopes('#SSH-测试服务器'), [])
})

test('workspacePrefix / tokenSafeName / assetMentionToken', () => {
  assert.equal(workspacePrefix('ssh'), 'SSH')
  assert.equal(workspacePrefix('db'), 'DB')
  assert.equal(workspacePrefix('docker'), 'Docker')
  assert.equal(workspacePrefix('local'), 'LOCAL')
  assert.equal(tokenSafeName('我的  测试@机#器'), '我的-测试-机-器')
  assert.equal(assetMentionToken('ssh', '测试 服务器'), '#SSH-测试-服务器')
})

test('assetSummary 按类型给连接摘要', () => {
  assert.equal(assetSummary(makeAsset({ config: { host: '10.0.0.1', port: 2222 } })), '10.0.0.1:2222')
  assert.equal(assetSummary(makeAsset({ type: 'db', config: { dbType: 'redis', address: 'r://x' } })), 'redis · r://x')
  assert.equal(assetSummary(makeAsset({ type: 'docker', config: { dockerTransport: 'ssh' } })), 'ssh')
  assert.equal(assetSummary(makeAsset({ type: 'local', name: '本机', config: { rootPath: 'D:/code' } })), 'D:/code')
})

test('filterMentionedAssets 按 token 匹配(大小写不敏感)', () => {
  const assets = [
    makeAsset({ id: 'a1', name: '测试服务器' }),
    makeAsset({ id: 'a2', type: 'db', name: '订单库' })
  ]
  assert.deepEqual(filterMentionedAssets(assets, '看看 #ssh-测试服务器').map(a => a.id), ['a1'])
  assert.deepEqual(filterMentionedAssets(assets, '#DB-订单库'), assets.filter(a => a.id === 'a2'))
  assert.deepEqual(filterMentionedAssets(assets, '没有引用'), [])
})
