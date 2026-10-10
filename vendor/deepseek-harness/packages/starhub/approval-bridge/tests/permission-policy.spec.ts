/**
 * starhub-approval-bridge 的权限接线(2026-10-10 事故回归,组合测试):
 *
 * 事故:本桥在 `session/created` 上抢在 dsh permission-presets 之前写
 * `approval/policy=ask`,把 permission-presets 的「全新会话」判定
 * (preset/sandbox/approval 三者全空)打脏,它只好用**进程默认沙箱**补空缺——
 * 设置里选「完全权限」的新会话实际拿到「工作区内修改」(会话日志 seq0~2
 * 依次是 approval/policy=ask → permission/preset=workspace-write →
 * sandbox/mode=workspace-write)。
 *
 * 本文件用真实 Context + 真实 ApprovalService + 真实 SessionStore 钉住:
 * - 组合里有 permission-presets 时,本桥一个新会话都不写权限事实;
 * - 组合里没有 permission-presets(内嵌)时,保留给新会话钉 ask 的旧行为;
 * - 风险门只产出 ask:策略 never(完全权限)时放行,不制造注定被驳回的 ask。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import * as bridge from '../src/index.ts'

/**
 * 挂一个最小真实组合:SessionStore + ApprovalService + 本桥(answerer:false,
 * 应答桥不参与,故不需要 sdk-transport)。
 * @param options - presets=true 冒充 permission-presets 在场;policy 是审批默认值。
 * @returns 已挂载的 context。
 */
async function mounted(options: { presets?: boolean; policy?: 'ask' | 'never' } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ApprovalService, { policy: options.policy ?? 'ask' })
  // 本桥的 inject 仍声明 settings(组合兼容),这里给个空实现:权限命名空间
  // 归上游 permission-presets,本桥不再读写设置。
  ctx.provide('settings', { describe: () => [] })
  if (options.presets === true) ctx.provide('permissionPresets', { catalog: () => ({ options: [] }) })
  await ctx.plugin(bridge, { answerer: false })
  return ctx
}

/** 会话里写过的 approval/policy 事件(本桥唯一的权限写入面)。 */
function policyWrites(session: Session): unknown[] {
  return session.snapshotEvents().filter(event => event.type === 'approval/policy')
}

/** 以 dsh-tools 调用点同形的方式跑一次 tools/pre-execute 瀑布。 */
function gate(ctx: Context, session: Session, tool: string, args: unknown): Promise<PreToolDecision> {
  return ctx.waterfall(
    'tools/pre-execute',
    { name: tool, arguments: args, agent: { session } } as never,
    () => Promise.resolve({ kind: 'allow' } as PreToolDecision),
  )
}

describe('session permission pinning', () => {
  it('writes nothing when dsh permission-presets owns the preset', async () => {
    const ctx = await mounted({ presets: true })
    const session = ctx.sessions.create(SessionId('preset-owned'))
    expect(policyWrites(session)).toEqual([])
    expect(ctx.approval.overrideOf(session)).toBeUndefined()
  })

  it('pins ask for a fresh session in embedded compositions (no preset service)', async () => {
    const ctx = await mounted()
    const session = ctx.sessions.create(SessionId('embedded'))
    expect(ctx.approval.overrideOf(session)).toBe('ask')
    expect(policyWrites(session)).toHaveLength(1)
  })
})

describe('risk gate follows the session approval policy', () => {
  it('asks for a risky starhub command under the ask policy', async () => {
    const ctx = await mounted()
    const session = ctx.sessions.create(SessionId('gate-ask'))
    expect(await gate(ctx, session, 'ssh_exec', { command: 'rm -rf /tmp/x' }))
      .toMatchObject({ kind: 'ask' })
    expect(await gate(ctx, session, 'android_exec', { command: 'pm list packages' }))
      .toMatchObject({ kind: 'ask' })
  })

  it('passes risky starhub commands through under the never policy (full access)', async () => {
    const ctx = await mounted()
    const session = ctx.sessions.create(SessionId('gate-never'))
    session.append('approval/policy', { policy: 'never' })
    expect(await gate(ctx, session, 'ssh_exec', { command: 'rm -rf /tmp/x' }))
      .toEqual({ kind: 'allow' })
    expect(await gate(ctx, session, 'db_query', { sql: 'DROP TABLE users' }))
      .toEqual({ kind: 'allow' })
  })

  it('leaves read-only commands and non-starhub tools alone', async () => {
    const ctx = await mounted()
    const session = ctx.sessions.create(SessionId('gate-allow'))
    expect(await gate(ctx, session, 'ssh_exec', { command: 'ls -la' })).toEqual({ kind: 'allow' })
    expect(await gate(ctx, session, 'read_file', { path: '/etc/hosts' })).toEqual({ kind: 'allow' })
  })
})
