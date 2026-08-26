// @vitest-environment jsdom
/**
 * `@` 资产 source(asset-source.ts):trigger/name、候选过滤与副标题、lexicon
 * 名单与 subscribeLexicon 刷新、warm 拉资产、pick 的 ReferenceInsert +
 * 轻绑定(settings.update 写 starhub-tool-context)、codec 的剪贴板投影与
 * 模型序列化(`<asset id="…">name (user@host)</asset>`),以及引用资产已删
 * 除时序列化失败阻止发送。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientSessionContext, InputTriggerPick } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createStarHubAssets, createToolSelectionBridge, type RustAsset } from '../src/client/store.ts'
import { renderAssetReference, createStarHubAssetSource } from '../src/client/asset-source.ts'
import { TOOL_CONTEXT_NAMESPACE } from '../src/client/tool-context.ts'

/** 构造一个最小资产(只带匹配所需的字段)。 */
function rustAsset(id: string, name: string, config: Record<string, unknown> = {}): RustAsset {
  return {
    id, type: 'ssh', name, group_id: null, config,
    key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
  }
}

/** 会话投影(契约 ClientSessionContext 只带稳定 id)。 */
function proj(sessionId = 's1'): ClientSessionContext {
  return { sessionId: sessionId as ClientSessionContext['sessionId'] }
}

/** 候选请求。 */
function req(query: string): { query: string; position: 'leading'; signal: AbortSignal } {
  return { query, position: 'leading', signal: new AbortController().signal }
}

/** 组装 pick(候选必须是 candidates() 返回的同一引用)。 */
function pickOf(candidate: { name: string; description?: string }): InputTriggerPick {
  return {
    candidate,
    session: proj(),
    position: 'leading',
    via: 'menu',
    span: { start: 0, end: 1, draftRev: 0 },
  }
}

function makeHarness(assets: ReturnType<typeof createStarHubAssets>, update: ReturnType<typeof vi.fn>) {
  const api = { settings: { update } } as unknown as IApiClient
  const selection = createToolSelectionBridge()
  const source = createStarHubAssetSource({ api, assets, selection })
  return { api, selection, source }
}

afterEach(() => {
  vi.restoreAllMocks()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('renderAssetReference', () => {
  it('renders name (user@host), host-only, database and bare-name forms as plain text', () => {
    expect(renderAssetReference({ id: 'a1', name: 'web-1', config: { username: 'deploy', host: '10.0.0.5' } }))
      .toBe('@web-1 (deploy@10.0.0.5)')
    expect(renderAssetReference({ id: 'a1', name: 'web-1', config: { host: '10.0.0.5' } }))
      .toBe('@web-1 (10.0.0.5)')
    expect(renderAssetReference({ id: 'a1', name: 'web-1', config: { database: 'mydb' } }))
      .toBe('@web-1 (mydb)')
    expect(renderAssetReference({ id: 'a1', name: 'web-1', config: {} }))
      .toBe('@web-1')
  })

  it('annotates every Docker asset reference (delete-guard hard rule)', () => {
    expect(renderAssetReference({ id: 'd1', name: 'docker-1', type: 'docker', config: {} }))
      .toBe('@docker-1 [Docker]')
    expect(renderAssetReference({ id: 'd1', name: 'docker-1', type: 'docker', config: { host: '10.0.0.8' } }))
      .toBe('@docker-1 (10.0.0.8) [Docker]')
  })
})

describe('createStarHubAssetSource', () => {
  it('binds the @ trigger under the starhub-asset source name', () => {
    const { source } = makeHarness(createStarHubAssets(), vi.fn())
    expect(source.trigger).toBe('@')
    expect(source.name).toBe('starhub-asset')
    expect(source.codec).toBeDefined()
  })

  it('candidates filter the asset snapshot by name containment and carry the subtitle as description', async () => {
    const assets = createStarHubAssets()
    assets.source.set({
      assets: [
        rustAsset('a1', 'web-1', { username: 'deploy', host: '10.0.0.5' }),
        rustAsset('a2', 'web-2', { host: '10.0.0.6' }),
        rustAsset('a3', 'local-1', {}),
      ],
      loading: false, error: null, preview: false,
    })
    const { source } = makeHarness(assets, vi.fn())
    await expect(source.candidates(proj(), req('WEB'))).resolves.toEqual([
      { name: 'web-1', icon: 'SSH', description: 'deploy@10.0.0.5' },
      { name: 'web-2', icon: 'SSH', description: '10.0.0.6' },
    ])
    // 无副标题的资产:候选不带 description 键(exactOptionalPropertyTypes)
    await expect(source.candidates(proj(), req('local-1'))).resolves.toEqual([
      { name: 'local-1', icon: 'SSH' },
    ])
  })

  it.each([
    ['ssh', {}, 'SSH'],
    ['db', { dbType: 'mysql' }, 'DB'],
    ['db', { dbType: 'redis' }, 'DB'],
    ['db', { dbType: 'kafka' }, 'SSH'],
    ['db', {}, 'DB'],
    ['docker', {}, 'Docker'],
    ['local', {}, '本机'],
  ])('candidate icon marks the tool category: type %s → %s', async (type, config, badge) => {
    const assets = createStarHubAssets()
    assets.source.set({
      assets: [{ ...rustAsset('a1', 'x', config), type }],
      loading: false, error: null, preview: false,
    })
    const { source } = makeHarness(assets, vi.fn())
    const [candidate] = await source.candidates(proj(), req(''))
    expect(candidate).toMatchObject({ icon: badge })
  })

  it('candidates return everything on an empty query and nothing when aborted', async () => {
    const assets = createStarHubAssets()
    assets.source.set({ assets: [rustAsset('a1', 'web-1'), rustAsset('a2', 'web-2')], loading: false, error: null, preview: false })
    const { source } = makeHarness(assets, vi.fn())
    await expect(source.candidates(proj(), req(''))).resolves.toHaveLength(2)
    const controller = new AbortController()
    controller.abort()
    await expect(source.candidates(proj(), { query: '', position: 'leading', signal: controller.signal }))
      .resolves.toEqual([])
  })

  it('lexicon serves the asset-name roll and subscribeLexicon forwards snapshot changes', () => {
    const assets = createStarHubAssets()
    assets.source.set({ assets: [rustAsset('a1', 'web-1'), rustAsset('a2', 'web-2')], loading: false, error: null, preview: false })
    const { source } = makeHarness(assets, vi.fn())
    expect(source.lexicon!(proj())).toEqual(['web-1', 'web-2'])
    let notified = 0
    const off = source.subscribeLexicon!(proj(), () => { notified += 1 })
    assets.source.set({ assets: [rustAsset('a1', 'web-1')], loading: false, error: null, preview: false })
    expect(notified).toBe(1)
    off()
    assets.source.set({ assets: [], loading: false, error: null, preview: false })
    expect(notified).toBe(1)
    // 刷新后的名单也同步变化
    expect(source.lexicon!(proj())).toEqual([])
  })

  it('warm refreshes the asset list (snapshot leaves the preview state after get_assets)', async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
    w.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve([rustAsset('a1', 'web-1')]) }
    try {
      const assets = createStarHubAssets()
      const { source } = makeHarness(assets, vi.fn())
      source.warm!(proj())
      expect(assets.source.getSnapshot().loading).toBe(true)
      await vi.waitFor(() =>{  expect(assets.source.getSnapshot().loading).toBe(false) })
      expect(assets.source.getSnapshot().assets).toHaveLength(1)
    } finally {
      delete w.__TAURI_INTERNALS__
    }
  })

  it('onPick inserts a reference with the asset id and light-binds the tool context', async () => {
    const assets = createStarHubAssets()
    assets.source.set({
      assets: [rustAsset('a1', 'web-1', { username: 'deploy', host: '10.0.0.5' })],
      loading: false, error: null, preview: false,
    })
    const update = vi.fn(() => Promise.resolve({ result: { ok: true } }))
    const { selection, source } = makeHarness(assets, update)
    selection.selectSubcategory('terminal')
    const [candidate] = await source.candidates(proj(), req(''))
    const outcome = source.onPick(pickOf(candidate!))
    expect(outcome).toEqual({
      insert: {
        source: 'starhub-asset',
        ref: 'a1',
        label: 'web-1 (deploy@10.0.0.5)',
        clipboardText: '@web-1',
      },
    })
    // 轻绑定:settings.update 写 starhub-tool-context 全量四字段补丁
    expect(update).toHaveBeenCalledWith({
      ns: TOOL_CONTEXT_NAMESPACE,
      patch: { subcategory: 'terminal', assetId: 'a1', assetName: 'web-1', routePrefix: '' },
    })
  })

  it.each([
    ['ssh', 'terminal', 'ssh-1'],
    ['db', 'database', 'db-1'],
    ['docker', 'docker', 'docker-1'],
  ])('onPick binds a %s asset without opening a workbench', async (type, subcategory, id) => {
    const assets = createStarHubAssets()
    assets.source.set({
      assets: [{ ...rustAsset(id, `${type}-asset`), type }],
      loading: false, error: null, preview: false,
    })
    const update = vi.fn(() => Promise.resolve({ result: { ok: true } }))
    const { selection, source } = makeHarness(assets, update)
    selection.selectSubcategory(subcategory)
    const [candidate] = await source.candidates(proj(), req(''))
    source.onPick(pickOf(candidate!))
    expect(update).toHaveBeenCalledWith({
      ns: TOOL_CONTEXT_NAMESPACE,
      patch: {
        subcategory,
        assetId: id,
        assetName: `${type}-asset`,
        routePrefix: '',
      },
    })
  })

  it('onPick falls back to plain text for a candidate this source did not produce', () => {
    const { source } = makeHarness(createStarHubAssets(), vi.fn())
    const outcome = source.onPick(pickOf({ name: 'foreign' }))
    expect(outcome).toEqual({ text: '@foreign ' })
  })

  it('onPick annotates a Docker asset in the insert label and candidate description', async () => {
    const assets = createStarHubAssets()
    assets.source.set({
      assets: [{ ...rustAsset('d1', 'docker-1'), type: 'docker' }],
      loading: false, error: null, preview: false,
    })
    const { source } = makeHarness(assets, vi.fn(() => Promise.resolve({ result: { ok: true } })))
    const [candidate] = await source.candidates(proj(), req(''))
    expect(candidate?.icon).toBe('Docker')
    expect(candidate?.description).toBe('删除操作需用户确认')
    const outcome = source.onPick(pickOf(candidate!))
    expect(outcome).toMatchObject({
      insert: { source: 'starhub-asset', ref: 'd1', label: 'docker-1 [Docker]', clipboardText: '@docker-1' },
    })
  })

  it('light binding swallows settings.update failures', async () => {
    const update = vi.fn(() => Promise.reject(new Error('namespace missing')))
    const assets = createStarHubAssets()
    assets.source.set({ assets: [rustAsset('a1', 'web-1')], loading: false, error: null, preview: false })
    const { source } = makeHarness(assets, update)
    const [candidate] = await source.candidates(proj(), req(''))
    const outcome = source.onPick(pickOf(candidate!))
    expect(outcome).toMatchObject({ insert: { ref: 'a1' } })
    expect(update).toHaveBeenCalled()
    // update 的 rejection 被 catch 吞掉:让拒绝链落定,不产生未处理拒绝
    await Promise.resolve()
    await Promise.resolve()
  })

  it('codec clipboard projects @name and falls back to the raw id for a deleted asset', async () => {
    const assets = createStarHubAssets()
    assets.source.set({ assets: [rustAsset('a1', 'web-1')], loading: false, error: null, preview: false })
    const { source } = makeHarness(assets, vi.fn())
    expect(source.codec!.clipboardText('a1')).toBe('@web-1')
    expect(source.codec!.clipboardText('gone')).toBe('@gone')
  })

  it('codec serialize produces the model form and rejects when the referenced asset is gone', async () => {
    const assets = createStarHubAssets()
    assets.source.set({
      assets: [rustAsset('a1', 'web-1', { username: 'deploy', host: '10.0.0.5' })],
      loading: false, error: null, preview: false,
    })
    const { source } = makeHarness(assets, vi.fn())
    await expect(source.codec!.serialize('a1', new AbortController().signal))
      .resolves.toBe('@web-1 (deploy@10.0.0.5)')
    // 资产删除后:序列化失败 = 阻止发送(流水线契约,绝不静默降级)
    await expect(source.codec!.serialize('gone', new AbortController().signal))
      .rejects.toThrow(/已不存在/)
  })
})
