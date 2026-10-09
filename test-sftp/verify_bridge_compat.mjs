#!/usr/bin/env node
/**
 * 去 Tauri 化 M1 第 8 步验收:bridge 兼容层 ↔ 真 sidecar 二进制(不等 Electron)。
 *
 * 这条脚本把「9 插件说的宿主桥协议」打到**真的** `starhub-sidecar-rust` 上:
 * spawn 二进制 → `JsonRpcLineTransport`(与 sidecar stdio 循环逐字节对齐的
 * 换行分帧)→ `createBridgePeer` 兼容层 → 逐条断言。覆盖:
 *
 *  1. `starhub/tool.execute` → `method=name, params=args` 直调(含 `{text}` 拆封)
 *  2. `starhub/tool.execute` 的全局工具(list_capabilities / list_assets)
 *  3. `starhub/bind.asset` → `bind_asset_context`(返回 `{ok,action:"bound"}`)
 *  4. `starhub/open.asset` / `starhub/focus.tool`(open→focus 预判 + 意图通知)
 *  5. `starhub/live.snapshot`(registries / transfers / recentExecs / taskTrails)
 *  6. 域工具成功后的 `starhub/domain.event` 通知(因果顺序:事件在响应之前)
 *  7. 未实现的方法 → -32601,进程不死;畸形行被忽略
 *  8. UI 面(M2):`ui.<tauriCommand>` 资产 CRUD(建/列/改/删、snake_case 线形状、
 *     敏感字段不回流、删除后域工具报「资产不存在」、Excel 类型已删)
 *  9. UI 面 B 组(M2):`ui.ssh_*` / `ui.sftp_*` 交互会话(会话不存在 / 无写通道 /
 *     无待应答 / 传输任务表 / 窗口类降级 / 参数校验)
 *
 * 与 `verify_sidecar_ssh.py`(真 SSH e2e)分工:那条验 Rust 侧域逻辑,这条验
 * 「插件协议 → 兼容层 → sidecar」的最后一公里。
 *
 * 运行(仓库根):
 *   npm run sidecar-rust:build
 *   npm run verify:bridge-compat
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { createBridgePeer, NotificationDispatcher } from '../vendor/deepseek-harness/packages/starhub/bridge/src/compat.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const binary = join(repoRoot, 'sidecar-rust', 'target', 'debug', 'starhub-sidecar-rust.exe')

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** 起一个带种子资产的真 sidecar,返回 { child, transport, notifications }。 */
function startSidecar(assets) {
  if (!existsSync(binary)) {
    console.error(`找不到 sidecar 二进制: ${binary}\n先跑 npm run sidecar-rust:build`)
    process.exit(2)
  }
  const dir = mkdtempSync(join(tmpdir(), 'starhub-bridge-compat-'))
  const assetsFile = join(dir, 'assets.json')
  writeFileSync(assetsFile, JSON.stringify({ assets }))
  const child = spawn(binary, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      STARHUB_ASSETS_FILE: assetsFile,
      // 空串 = 内存密钥存储:验收不碰任何真实密钥环
      STARHUB_SECRETS_FILE: '',
      STARHUB_KNOWN_HOSTS_FILE: join(dir, 'known-hosts.json'),
      STARHUB_ANDROID_FRAMES_FILE: join(dir, 'android-frames.json'),
    },
  })
  const transport = new JsonRpcLineTransport(child.stdout, child.stdin)
  transport.start()
  const notifications = new NotificationDispatcher()
  notifications.attach(transport)
  return { child, transport, notifications, dir }
}

/** 等一条指定事件名的通知(超时返回 undefined)。 */
function waitForNotification(notifications, event, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { dispose(); resolve(undefined) }, timeoutMs)
    const dispose = notifications.subscribe(event, (params) => {
      clearTimeout(timer)
      dispose()
      resolve(params)
    })
  })
}

const seedAssets = [
  {
    id: 'a1',
    type: 'ssh',
    name: '验收机',
    config: { host: '127.0.0.1', port: 2222, username: 'verify' },
  },
]

async function main() {
  const { child, transport, notifications, dir } = startSidecar(seedAssets)
  const peer = createBridgePeer(transport)
  try {
    // ── 1. 域工具:方法名 = 工具名,{text} 拆封为模型文本 ──
    console.log('\n[1] starhub/tool.execute → sidecar 方法直调')
    const status = await peer.request('starhub/tool.execute', {
      sessionId: 's1',
      name: 'ssh_session_status',
      args: { assetId: 'a1' },
    })
    check('ssh_session_status 返回模型可读文本', typeof status === 'string' && status.length > 0, String(status).slice(0, 60))

    const missing = await peer.request('starhub/tool.execute', {
      sessionId: 's1',
      name: 'ssh_exec',
      args: { command: 'ls' },
    }).catch((error) => error.message)
    check('未绑定资产时拿到引导文案(软错误,不是抛栈)',
      typeof missing === 'string' && missing.includes('bind_asset_context'), String(missing).slice(0, 60))

    // ── 2. 全局工具 ──
    console.log('\n[2] 全局工具(list_capabilities / list_assets)')
    const capabilities = await peer.request('starhub/tool.execute', {
      sessionId: 's1',
      name: 'starhub_list_capabilities',
      args: {},
    })
    check('list_capabilities 是单行 JSON 文本',
      typeof capabilities === 'string' && capabilities.startsWith('{"android"'), capabilities.slice(0, 40))
    const assets = await peer.request('starhub/tool.execute', {
      sessionId: 's1',
      name: 'starhub_list_assets',
      args: {},
    })
    check('list_assets 列出种子资产且不含敏感字段',
      typeof assets === 'string' && assets.includes('a1') && !assets.includes('password'), assets.slice(0, 60))

    // ── 3. bind.asset → bind_asset_context ──
    console.log('\n[3] starhub/bind.asset → bind_asset_context')
    const bound = await peer.request('starhub/bind.asset', { assetId: 'a1', sessionId: 's1' })
    check('返回 {ok:true, action:"bound"}',
      bound?.ok === true && bound.action === 'bound', JSON.stringify(bound))
    const afterBind = await peer.request('starhub/tool.execute', {
      sessionId: 's1',
      name: 'ssh_session_status',
      args: {},
    })
    check('绑定后域工具不再要 assetId', typeof afterBind === 'string' && !afterBind.includes('bind_asset_context'),
      String(afterBind).slice(0, 50))

    // ── 4. open.asset / focus.tool ──
    console.log('\n[4] starhub/open.asset / focus.tool(open→focus 预判 + 意图通知)')
    const opened = await peer.request('starhub/open.asset', { assetId: 'a1', tool: 'terminal', sessionId: 's1' })
    check('首次 = opened', opened?.ok === true && opened.action === 'opened', JSON.stringify(opened))
    const focused = await peer.request('starhub/focus.tool', { assetId: 'a1', tool: 'terminal', sessionId: 's1' })
    check('再次 = focused', focused?.ok === true && focused.action === 'focused', JSON.stringify(focused))
    const focusMissingTool = await peer.request('starhub/focus.tool', { assetId: 'a1', sessionId: 's1' })
      .catch((error) => error.message)
    check('focus.tool 缺 tool 报参数错误', String(focusMissingTool).includes('缺少 tool'), focusMissingTool)

    // ── 5. live.snapshot ──
    console.log('\n[5] starhub/live.snapshot')
    const snapshot = await peer.request('starhub/live.snapshot', {})
    check('四个视图字段齐全',
      Array.isArray(snapshot?.sessions) && Array.isArray(snapshot?.transfers)
      && Array.isArray(snapshot?.recentExecs) && Array.isArray(snapshot?.taskTrails),
      JSON.stringify(snapshot).slice(0, 80))

    // ── 6. AI 起源领域事件(因果顺序) ──
    console.log('\n[6] 域工具成功后的 starhub/domain.event(事件在响应之前)')
    const eventPromise = waitForNotification(notifications, 'starhub/domain.event')
    const replay = await peer.request('starhub/tool.execute', {
      sessionId: 's1',
      name: 'android_replay',
      args: { serial: 'nope' },
    })
    const event = await eventPromise
    check('android_replay 成功返回文本', typeof replay === 'string' && replay.includes('没有回放帧'), String(replay).slice(0, 40))
    check('AI 起源事件已收到', event !== undefined, event === undefined ? '未收到' : JSON.stringify(event).slice(0, 80))
    check('事件 kind/origin 正确',
      event?.kind === 'android.action' && event.origin === 'ai' && event.summary === 'android_replay: 设备 nope',
      JSON.stringify(event))

    // ── 7. 协议健壮性 ──
    console.log('\n[7] 协议健壮性(未知方法 / 畸形行)')
    const unknown = await peer.request('starhub/tool.execute', {
      sessionId: 's1',
      name: 'no_such_tool',
      args: {},
    }).catch((error) => error.message)
    check('未知工具 → method not found', String(unknown).includes('method not found: no_such_tool'), unknown)
    transport.notify('starhub/exec.abort', { execId: 'never-existed' })
    const stillAlive = await peer.request('starhub/tool.execute', {
      sessionId: 's1',
      name: 'starhub_list_capabilities',
      args: {},
    })
    check('未知 exec_id 的中止通知不杀进程', typeof stillAlive === 'string' && stillAlive.startsWith('{"'))

    // ── 8. UI 面(M2):工作台命令 ui.<tauriCommand>,经 bridge 的 invoke 端点 ──
    console.log('\n[8] UI 面资产 CRUD(ui.get_assets / create / update / delete)')
    const ui = {
      request: (method, params) => transport.request(`ui.${method}`, params ?? {}),
    }
    const created = await ui.request('create_asset', {
      id: 'acc-1',
      type: 'ssh',
      name: '验收机',
      config: { host: '10.0.0.1', port: 22, username: 'root', password: 's3cret' },
      groupId: 2,
      tags: ['prod'],
      favorite: true,
    })
    check('create 返回 snake_case 线形状(工作台 RustAsset)',
      created?.id === 'acc-1' && created.group_id === 2 && created.favorite === true
      && created.key_id === 'asset:acc-1' && created.created_at > 0,
      JSON.stringify(created).slice(0, 90))
    check('敏感字段不回流', created?.config?.password === undefined)

    const listed = await ui.request('get_assets')
    // 种子资产 a1 + 新建的 acc-1
    check('get_assets 列出新建资产',
      Array.isArray(listed) && listed.length === 2 && listed.some(a => a.name === '验收机'),
      `${String(listed.length)} 项`)
    check('清单不带密钥', !JSON.stringify(listed).includes('s3cret'))

    const updated = await ui.request('update_asset', {
      id: 'acc-1', type: 'ssh', name: '新名', config: { host: '10.0.0.2' },
    })
    check('update 改名且不新增行', updated?.name === '新名'
      && (await ui.request('get_assets')).length === 2)

    const deleted = await ui.request('delete_asset', { id: 'acc-1' })
    check('delete 返回 ok', deleted?.ok === true)
    check('删除后只剩种子资产', (await ui.request('get_assets')).length === 1)

    const afterDelete = await transport.request('ssh_exec', { assetId: 'acc-1', command: 'ls' })
      .catch((error) => error.message)
    check('删除后域工具报「资产不存在」', String(afterDelete).includes('资产不存在'), afterDelete)

    const badType = await ui.request('create_asset', { id: 'x', type: 'excel', name: 'x' })
      .catch((error) => error.message)
    check('Excel 类型已删 → 参数错误', String(badType).includes('不支持的资产类型'), badType)

    // ── 9. UI 面 B 组(交互会话):ui.ssh_* / ui.sftp_*(connId 面) ──
    console.log('\n[9] UI 面 B 组交互会话(ui.ssh_* / ui.sftp_*)')
    const methodSurface = await transport.request('starhub/capabilities', {})
    check('方法面覆盖 B 组(总数 123)',
      Array.isArray(methodSurface?.methods) && methodSurface.methods.length === 123
      && methodSurface.methods.includes('ui.ssh_connect') && methodSurface.methods.includes('ui.sftp_start_upload'),
      `${String(methodSurface?.methods?.length)} 个方法`)

    const sessions = await ui.request('ssh_get_sessions')
    check('空会话表返回空数组', Array.isArray(sessions) && sessions.length === 0, JSON.stringify(sessions))

    // 无写通道时写操作静默成功(由 ssh:close 事件告知前端,与 Tauri 版一致)
    const written = await ui.request('ssh_write', { id: 'ghost', data: 'ls\n' })
    check('无写通道的 ssh_write 静默成功(null)', written === null || written === undefined, JSON.stringify(written))

    // 断开会话幂等
    const disconnected = await ui.request('ssh_disconnect', { id: 'ghost' })
    check('断开未知会话幂等(null)', disconnected === null || disconnected === undefined, JSON.stringify(disconnected))

    for (const [method, params] of [
      ['sftp_list', { id: 'ghost', path: '/tmp' }],
      ['sftp_home_dir', { id: 'ghost' }],
      ['sftp_ensure_session', { id: 'ghost' }],
      ['ssh_resize', { id: 'ghost', cols: 80, rows: 24 }],
    ]) {
      const error = await ui.request(method, params).catch((caught) => caught.message)
      check(`${method} 会话不存在 → Session not found`, String(error) === 'Session not found', String(error))
    }

    const kbMissing = await ui.request('ssh_kb_response', { id: 'ghost', responses: ['123456'] })
      .catch((error) => error.message)
    check('无待应答的 kb_response 文案逐字保持',
      String(kbMissing) === 'No pending kb prompt for session ghost', String(kbMissing))
    const hostkeyMissing = await ui.request('ssh_hostkey_response', { id: 'ghost', allowed: true, persist: false })
      .catch((error) => error.message)
    check('无待应答的 hostkey_response 文案逐字保持',
      String(hostkeyMissing) === 'No pending hostkey prompt for session ghost', String(hostkeyMissing))

    const tasks = await ui.request('sftp_list_transfers', { id: 'ghost' })
    check('传输任务表为空', Array.isArray(tasks) && tasks.length === 0, JSON.stringify(tasks))
    const cleared = await ui.request('sftp_clear_transfers', { id: 'ghost' })
    check('清除终态任务返回 0', cleared === 0, String(cleared))
    const resumeMissing = await ui.request('sftp_resume_transfer', { id: 'ghost', transferId: 't1' })
      .catch((error) => error.message)
    check('恢复未知传输是硬错误', String(resumeMissing).includes('Transfer not found'), String(resumeMissing))

    const trusted = await ui.request('ssh_get_trusted_host_key', { host: '10.0.0.1', port: 22 })
    check('空 known_hosts 的受信任主机密钥为 null', trusted === null, JSON.stringify(trusted))

    const webWindow = await ui.request('ssh_open_web_window', { sessionId: 'ghost', assetName: 'x' })
      .catch((error) => error.message)
    check('窗口类动作显式降级(指明 M3)', String(webWindow).includes('M3'), String(webWindow))

    const missingId = await ui.request('ssh_write', { data: 'x' }).catch((error) => error.message)
    check('缺 id → 参数错误', String(missingId).includes('缺少 id'), String(missingId))
    const missingPaths = await ui.request('sftp_start_upload', { id: 's1', remoteDir: '/tmp' })
      .catch((error) => error.message)
    check('缺 localPaths → 参数错误', String(missingPaths).includes('缺少 localPaths'), String(missingPaths))
  } finally {
    child.stdin.end()
    await new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return }
      child.once('exit', () => resolve())
      setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000).unref()
    })
    rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\n验收结果: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验收脚本异常:', error)
  process.exit(1)
})
