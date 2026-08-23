/**
 * @deepseek-ai/dsh-starhub-commit-message — StarHub「AI 生成提交信息」的
 * host 端点(StarHub-local package, not upstream)。会话头部 git 分支胶囊
 * (client-nav GitBranchPill)的「AI」按钮把工作区变更摘要 POST 到
 * `/starhub/git/commit-message`,本插件用 agentDefaultModel 当前路由做一次
 * one-shot 辅助 LLM 调用,返回草稿提交信息;用户可在输入框里再编辑后提交。
 *
 * 边界:路由只做文本生成,不触碰 git(变更摘要由客户端经 local_shell_exec
 * 采好后随请求带来);输入体量受 maxInputBytes 约束,超限时由客户端先行截断,
 * 本端二次拒绝。模型路由缺省取 agentDefaultModel.currentSelection(),
 * cordis.yml 可用 provider/model 对固定路由(两者必须同时出现)。
 *
 * @module @deepseek-ai/dsh-starhub-commit-message
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent-default-model'

/** Stable Cordis plugin name. */
export const name = 'starhub-commit-message'

/** Services required before the route can be claimed. */
export const inject = ['webServer', 'llm', 'agentDefaultModel']

/** Exact HTTP path claimed from the dsh web server. */
export const COMMIT_MESSAGE_PATH = '/starhub/git/commit-message'

/** 提交信息生成端点的插件配置。 */
export interface Config {
  /** 请求体(status + diffStat + recentSubjects)允许的最大 UTF-8 字节数。 */
  readonly maxInputBytes: number
  /** 草稿输出的 max_tokens。 */
  readonly maxOutputTokens: number
  /** 单次 LLM 调用的整体超时(毫秒)。 */
  readonly timeoutMs: number
  /** 固定 provider 路由;与 model 必须同时出现,缺省时跟随默认模型选择。 */
  readonly provider?: string
  /** 固定 model;与 provider 必须同时出现。 */
  readonly model?: string
}

/** Loader schema: byte/token/time budgets plus an optional fixed model route. */
export const Config: z<Config> = z.object({
  /** 请求体(status + diffStat + recentSubjects)允许的最大 UTF-8 字节数。 */
  maxInputBytes: z.number().step(1).min(1).required(),
  /** 草稿输出的 max_tokens。 */
  maxOutputTokens: z.number().step(1).min(1).required(),
  /** 单次 LLM 调用的整体超时(毫秒)。 */
  timeoutMs: z.number().step(1).min(1).required(),
  /** 固定 provider 路由;与 model 必须同时出现,缺省时跟随默认模型选择。 */
  provider: z.string(),
  /** 固定 model;与 provider 必须同时出现。 */
  model: z.string(),
})

/** 客户端 POST 的 JSON 体(变更摘要,客户端已截断)。 */
export interface CommitMessageRequest {
  /** `git status --porcelain` 输出(必有改动,空串视为无改动)。 */
  readonly status: string
  /** `git diff HEAD --stat` 输出(新仓库回落 `git diff --stat`;可为空)。 */
  readonly diffStat: string
  /** 最近提交主题(`git log --pretty=%s`),用于对齐仓库既有提交风格。 */
  readonly recentSubjects: readonly string[]
}

/** 端点成功响应体。 */
export interface CommitMessageResponse {
  /** 草稿提交信息(已去空白;不含解释性文字)。 */
  readonly message: string
}

interface ResolvedConfig {
  readonly maxInputBytes: number
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  readonly provider?: string
  readonly model?: string
}

/** 校验并固化插件配置;provider/model 必须成对出现(参照 session-title-llm)。 */
function resolveConfig(config: Config | null | undefined): ResolvedConfig {
  // 入参是 cordis.yml 反序列化的未信值;运行时校验由 schemastery 完成。
  const value = Config(config)
  const hasProvider = value.provider !== undefined
  if (hasProvider !== (value.model !== undefined)) {
    throw new Error('starhub-commit-message: provider and model must be supplied together')
  }
  if (hasProvider && (value.provider === '' || value.model === '')) {
    throw new Error('starhub-commit-message: provider and model overrides must be non-empty strings')
  }
  return Object.freeze(value)
}

/**
 * 解析并校验请求体(wire 边界);失败抛出带用户可读文案的 Error。
 * @param raw - 请求体 JSON 解析结果。
 * @returns 归一化的变更摘要。
 */
export function parseRequestBody(raw: unknown): CommitMessageRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('请求体必须是 JSON 对象')
  }
  const body = raw as Record<string, unknown>
  if (typeof body.status !== 'string' || typeof body.diffStat !== 'string'
    || !Array.isArray(body.recentSubjects)
    || body.recentSubjects.some(item => typeof item !== 'string')) {
    throw new Error('请求体缺少 status / diffStat / recentSubjects 字段或类型不对')
  }
  if (body.status.trim() === '') {
    throw new Error('工作区没有改动,无可提交的变更')
  }
  return {
    status: body.status,
    diffStat: body.diffStat,
    recentSubjects: body.recentSubjects as string[],
  }
}

/** 系统指令:按仓库近期提交风格(语言与 Conventional Commits 约定)起草。 */
const SYSTEM_PROMPT = [
  'Draft a git commit message for the described working-tree changes.',
  'Return only the commit message text: no quotes, no explanation, no Markdown fences.',
  'The subject line must be at most 72 characters. Add a blank line and a short bullet body only when the changes span multiple distinct concerns.',
  'Match the language and convention of the recent commit subjects when they show one (e.g. Conventional Commits, emoji prefixes); otherwise use Conventional Commits in the language of the change descriptions.',
  'Describe only what the input shows; never invent changes.',
].join('\n')

/**
 * 把变更摘要帧为一条用户消息(JSON 承载,用户文本无法破坏结构分隔)。
 * @param request - 已校验的变更摘要。
 * @returns 发给模型的用户消息文本。
 */
export function frameRequest(request: CommitMessageRequest): string {
  return `Draft the commit message from this JSON summary of the working tree:\n${JSON.stringify({
    status: request.status,
    diffStat: request.diffStat,
    recentSubjects: request.recentSubjects,
  })}`
}

/** 依赖面孔:测试用假的路由/生成器驱动 handler,不必启动 cordis。 */
export interface CommitMessageDeps {
  /** 解析本次调用使用的模型路由。 */
  readonly resolveRoute: () => ModelSelection
  /** 做一次 one-shot 生成并返回文本;失败抛错。 */
  readonly generate: (route: ModelSelection, prompt: string, system: string) => Promise<string>
}

/**
 * 组装端点 handler:POST JSON → 草稿;方法不对 405,体不对 400,
 * 体超限 413,生成失败 502。成功 200 `{ message }`。
 * @param deps - 路由解析与生成依赖。
 * @param config - 已校验的预算配置。
 * @returns node:http 请求处理器。
 */
export function createHandler(
  deps: CommitMessageDeps, config: ResolvedConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const writeJson = (res: ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }
  return async (req, res) => {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed' })
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of req) {
      const part = chunk as Buffer
      bytes += part.byteLength
      if (bytes > config.maxInputBytes) {
        writeJson(res, 413, { error: `变更摘要超过 ${config.maxInputBytes} 字节上限` })
        return
      }
      chunks.push(part)
    }
    let parsed: CommitMessageRequest
    try {
      parsed = parseRequestBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    try {
      const route = deps.resolveRoute()
      const message = (await deps.generate(route, frameRequest(parsed), SYSTEM_PROMPT)).trim()
      if (message === '') {
        writeJson(res, 502, { error: '模型没有产出文本,请重试' })
        return
      }
      writeJson(res, 200, { message } satisfies CommitMessageResponse)
    } catch (error) {
      writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * 注册 `/starhub/git/commit-message` exact 路由;生成经 ctx.llm 流式汇总,
 * 超时用 AbortSignal.timeout 兜底(端点是用户手势驱动的短调用)。
 * @param ctx - plugin context carrying webServer / llm / agentDefaultModel.
 * @param config - validated budgets and optional fixed route.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const deps: CommitMessageDeps = {
    resolveRoute: () => {
      if (resolved.provider !== undefined && resolved.model !== undefined) {
        return { provider: resolved.provider, model: resolved.model }
      }
      return ctx.agentDefaultModel.currentSelection()
    },
    generate: async (route, prompt, system) => {
      const assembler = new BlockAssembler()
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
        messages: [createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'dsh-starhub-commit-message' },
        })],
        system,
        maxTokens: resolved.maxOutputTokens,
        temperature: 0.3,
        signal: AbortSignal.timeout(resolved.timeoutMs),
      })
      for await (const chunk of stream) {
        assembler.push(chunk)
      }
      const finish = assembler.finish
      if (finish.kind !== 'stop') {
        const reason = finish.kind === 'error' || finish.kind === 'aborted'
          ? finish.failure.message
          : `生成提前结束(${finish.kind})`
        throw new Error(reason)
      }
      return assembler.blocks()
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
    },
  }
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact', path: COMMIT_MESSAGE_PATH, handler: createHandler(deps, resolved),
    }),
    'starhub-commit-message: /starhub/git/commit-message route',
  )
}
