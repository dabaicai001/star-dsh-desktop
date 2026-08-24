// @vitest-environment jsdom
/**
 * `@` 文件 source(file-source.ts):与资产 source 同一 @ trigger 并行——候选
 * 来自会话 cwd 目录树(空 query 只列顶层、非空递归展开)、pick 产出的
 * ReferenceInsert 序列化为 `@文件名 (路径)`、codec 剪贴板投影,以及会话
 * 无 cwd / 目录失败时的空候选。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientSessionContext, InputTriggerPick } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createStarhubFileSource, STARHUB_FILE_SOURCE } from '../src/client/file-source.ts'

interface Entry {
  name: string
  path: string
  kind: 'directory' | 'file'
  size: number
  modifiedAt: number | null
  readonly: boolean
  hidden: boolean
}

function dir(name: string, path: string): Entry {
  return { name, path, kind: 'directory', size: 0, modifiedAt: 1, readonly: false, hidden: false }
}

function file(name: string, path: string): Entry {
  return { name, path, kind: 'file', size: 10, modifiedAt: 1, readonly: false, hidden: false }
}

/** 按目录路径分派的 local_list_directory stub;返回调用记录。 */
function stubFs(trees: Record<string, Entry[]>) {
  const calls: string[] = []
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: { path?: string }) => {
      if (cmd !== 'local_list_directory') return Promise.reject(new Error(`unexpected: ${cmd}`))
      const path = args?.path ?? ''
      calls.push(path)
      const hit = trees[path]
      if (hit === undefined) return Promise.reject(new Error(`unknown dir: ${path}`))
      return Promise.resolve(hit)
    },
  }
  return {
    calls,
    restore: () => {
      if (prev === undefined) delete w.__TAURI_INTERNALS__
      else w.__TAURI_INTERNALS__ = prev
    },
  }
}

/** 会话投影(契约 ClientSessionContext 只带稳定 id)。 */
function proj(sessionId = 's1'): ClientSessionContext {
  return { sessionId: sessionId as ClientSessionContext['sessionId'] }
}

function req(query: string): { query: string; position: 'leading'; signal: AbortSignal } {
  return { query, position: 'leading', signal: new AbortController().signal }
}

function pickOf(candidate: { name: string; description?: string }): InputTriggerPick {
  return {
    candidate,
    session: proj(),
    position: 'leading',
    via: 'menu',
    span: { start: 0, end: 1, draftRev: 0 },
  }
}

function makeHarness(cwd?: string) {
  const sessions = {
    list: { getSnapshot: () => ({ current: 's1', ids: ['s1'], byId: { s1: { cwd } } }) },
  } as unknown as ISessions
  return { sessions, source: createStarhubFileSource({ sessions }) }
}

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
  vi.restoreAllMocks()
})

describe('createStarhubFileSource', () => {
  it('binds the @ trigger under the starhub-file name after the asset source', () => {
    const { source } = makeHarness('C:\\ws\\p')
    expect(source.trigger).toBe('@')
    expect(source.name).toBe(STARHUB_FILE_SOURCE)
    expect(source.order).toBe(10)
    expect(source.codec).toBeDefined()
  })

  it('lists the cwd top level for an empty query, directories first', async () => {
    restore = stubFs({
      'C:\\ws\\p': [file('z.ts', 'C:\\ws\\p\\z.ts'), dir('src', 'C:\\ws\\p\\src')],
    }).restore
    const { source } = makeHarness('C:\\ws\\p')
    await expect(source.candidates(proj(), req(''))).resolves.toEqual([
      { name: 'src', icon: '文件夹' },
      { name: 'z.ts', icon: '文件' },
    ])
  })

  it('recurses into directories when the query is non-empty and filters by name', async () => {
    restore = stubFs({
      'C:\\ws\\p': [dir('src', 'C:\\ws\\p\\src'), file('readme.md', 'C:\\ws\\p\\readme.md')],
      'C:\\ws\\p\\src': [file('app.ts', 'C:\\ws\\p\\src\\app.ts'), file('util.js', 'C:\\ws\\p\\src\\util.js')],
    }).restore
    const { source } = makeHarness('C:\\ws\\p')
    await expect(source.candidates(proj(), req('app'))).resolves.toEqual([
      { name: 'app.ts', icon: '文件', description: 'src/app.ts' },
    ])
  })

  it('includes directories whose own name matches the query', async () => {
    restore = stubFs({
      'C:\\ws\\p': [dir('app-src', 'C:\\ws\\p\\app-src')],
      'C:\\ws\\p\\app-src': [file('x.ts', 'C:\\ws\\p\\app-src\\x.ts')],
    }).restore
    const { source } = makeHarness('C:\\ws\\p')
    await expect(source.candidates(proj(), req('app'))).resolves.toEqual([
      { name: 'app-src', icon: '文件夹' },
    ])
  })

  it('skips noise directories (node_modules, .git) during recursion', async () => {
    restore = stubFs({
      'C:\\ws\\p': [dir('node_modules', 'C:\\ws\\p\\node_modules'), dir('src', 'C:\\ws\\p\\src')],
      'C:\\ws\\p\\node_modules': [file('x.js', 'C:\\ws\\p\\node_modules\\x.js')],
      'C:\\ws\\p\\src': [file('app.ts', 'C:\\ws\\p\\src\\app.ts')],
    }).restore
    const { source } = makeHarness('C:\\ws\\p')
    await expect(source.candidates(proj(), req('x'))).resolves.toEqual([])
    await expect(source.candidates(proj(), req('app'))).resolves.toEqual([
      { name: 'app.ts', icon: '文件', description: 'src/app.ts' },
    ])
  })

  it('filters noise directories from the top-level empty-query listing too', async () => {
    restore = stubFs({
      'C:\\ws\\p': [dir('.git', 'C:\\ws\\p\\.git'), file('main.ts', 'C:\\ws\\p\\main.ts')],
    }).restore
    const { source } = makeHarness('C:\\ws\\p')
    await expect(source.candidates(proj(), req(''))).resolves.toEqual([
      { name: 'main.ts', icon: '文件' },
    ])
  })

  it('caps the candidate list at MAX_CANDIDATES', async () => {
    const many = Array.from({ length: 205 }, (_, i) => file(`f${i}.ts`, `C:\\ws\\p\\f${i}.ts`))
    restore = stubFs({ 'C:\\ws\\p': many }).restore
    const { source } = makeHarness('C:\\ws\\p')
    const items = await source.candidates(proj(), req(''))
    expect(items).toHaveLength(200)
  })

  it('caps recursion at MAX_CANDIDATES for a non-empty query', async () => {
    const many = Array.from({ length: 205 }, (_, i) => file(`match${i}.ts`, `C:\\ws\\p\\match${i}.ts`))
    restore = stubFs({ 'C:\\ws\\p': many }).restore
    const { source } = makeHarness('C:\\ws\\p')
    const items = await source.candidates(proj(), req('match'))
    expect(items).toHaveLength(200)
  })

  it('aborts collection mid-fill for an empty query', async () => {
    restore = stubFs({
      'C:\\ws\\p': [file('a.ts', 'C:\\ws\\p\\a.ts'), file('b.ts', 'C:\\ws\\p\\b.ts')],
    }).restore
    const { source } = makeHarness('C:\\ws\\p')
    const controller = new AbortController()
    // 预置 abort:顶层列表成功返回后,首个 push 即短路。
    controller.abort()
    await expect(source.candidates(proj(), { query: '', position: 'leading', signal: controller.signal }))
      .resolves.toEqual([])
  })

  it('aborts the recursive walk for a non-empty query', async () => {
    restore = stubFs({
      'C:\\ws\\p': [dir('src', 'C:\\ws\\p\\src')],
      'C:\\ws\\p\\src': [file('app.ts', 'C:\\ws\\p\\src\\app.ts')],
    }).restore
    const { source } = makeHarness('C:\\ws\\p')
    const controller = new AbortController()
    controller.abort()
    await expect(source.candidates(proj(), { query: 'app', position: 'leading', signal: controller.signal }))
      .resolves.toEqual([])
  })

  it('stops descending past MAX_DEPTH and keeps searching through unmatched directories', async () => {
    const tree: Record<string, Entry[]> = {}
    // 8 层深:根 → d1 → … → d8(root 深度 0,文件在 d8 深度 8 > MAX_DEPTH 6)
    let path = 'C:\\ws\\p'
    for (let i = 1; i <= 8; i++) {
      const child = `${path}\\d${i}`
      tree[path] = [dir(`d${i}`, child)]
      path = child
    }
    tree[path] = [file('deep.ts', `${path}\\deep.ts`)]
    // 同层一个「不匹配 query 的目录」:不 push 但仍深入(内部有匹配文件)。
    tree['C:\\ws\\p'] = [dir('d1', 'C:\\ws\\p\\d1'), dir('other', 'C:\\ws\\p\\other')]
    tree['C:\\ws\\p\\other'] = [file('app.ts', 'C:\\ws\\p\\other\\app.ts')]
    restore = stubFs(tree).restore
    const { source } = makeHarness('C:\\ws\\p')
    // deep.ts 在深度 8,超过 MAX_DEPTH 6,不会出现;other/app.ts 可搜到。
    await expect(source.candidates(proj(), req('deep'))).resolves.toEqual([])
    await expect(source.candidates(proj(), req('app'))).resolves.toEqual([
      { name: 'app.ts', icon: '文件', description: 'other/app.ts' },
    ])
  })

  it('skips subdirectories that fail to read during a recursive search', async () => {
    restore = stubFs({
      'C:\\ws\\p': [dir('broken', 'C:\\ws\\p\\broken'), dir('src', 'C:\\ws\\p\\src')],
      'C:\\ws\\p\\src': [file('app.ts', 'C:\\ws\\p\\src\\app.ts')],
      // broken 无 stub → invoke reject → walk catch 返回
    }).restore
    const { source } = makeHarness('C:\\ws\\p')
    await expect(source.candidates(proj(), req('app'))).resolves.toEqual([
      { name: 'app.ts', icon: '文件', description: 'src/app.ts' },
    ])
  })

  it('returns empty candidates for a session without a cwd', async () => {
    restore = stubFs({}).restore
    const { source } = makeHarness()
    await expect(source.candidates(proj(), req(''))).resolves.toEqual([])
  })

  it('returns empty candidates when directory reading fails', async () => {
    restore = stubFs({}).restore
    const { source } = makeHarness('C:\\ws\\missing')
    await expect(source.candidates(proj(), req(''))).resolves.toEqual([])
  })

  it('aborts a slow collection when the signal fires', async () => {
    // 无 internals → invoke reject;信号预置 aborted 应直接返回空(不抛)。
    const { source } = makeHarness('C:\\ws\\p')
    const controller = new AbortController()
    controller.abort()
    await expect(source.candidates(proj(), { query: '', position: 'leading', signal: controller.signal }))
      .resolves.toEqual([])
  })

  it('pick produces a ReferenceInsert whose model form is @name (path)', async () => {
    const fs = stubFs({
      'C:\\ws\\p': [file('main.ts', 'C:\\ws\\p\\main.ts'), dir('src', 'C:\\ws\\p\\src')],
    })
    restore = fs.restore
    const { source } = makeHarness('C:\\ws\\p')
    const candidates = await source.candidates(proj(), req(''))
    const fileCandidate = candidates.find(c => c.name === 'main.ts')!
    const dirCandidate = candidates.find(c => c.name === 'src')!
    const filePick = pickOf(fileCandidate)
    const outcome = source.onPick(filePick)
    expect(outcome).toMatchObject({ insert: { source: STARHUB_FILE_SOURCE, ref: 'C:\\ws\\p\\main.ts', label: 'main.ts', clipboardText: '@main.ts' } })
    // codec 序列化 = 与文件树右键同款引用文本
    const ref = (outcome as { insert: { ref: string } }).insert.ref
    const signal = new AbortController().signal
    await expect(source.codec!.serialize(ref, signal)).resolves.toBe('@main.ts (C:\\ws\\p\\main.ts)')
    // 目录 pick → serialize 带斜杠
    const dirPick = pickOf(dirCandidate)
    const dirOutcome = source.onPick(dirPick)
    const dirRef = (dirOutcome as { insert: { ref: string } }).insert.ref
    await expect(source.codec!.serialize(dirRef, signal)).resolves.toBe('@src/ (C:\\ws\\p\\src)')
  })

  it('falls back to text for candidates this source did not produce', () => {
    const { source } = makeHarness('C:\\ws\\p')
    const outcome = source.onPick(pickOf({ name: 'ghost.ts' }))
    expect(outcome).toEqual({ text: '@ghost.ts ' })
  })

  it('codec clipboardText projects the bare @name', async () => {
    const fs = stubFs({
      'C:\\ws\\p': [file('main.ts', 'C:\\ws\\p\\main.ts')],
    })
    restore = fs.restore
    const { source } = makeHarness('C:\\ws\\p')
    const [candidate] = await source.candidates(proj(), req(''))
    const outcome = source.onPick(pickOf(candidate as { name: string }))
    const ref = (outcome as { insert: { ref: string } }).insert.ref
    expect(source.codec!.clipboardText(ref)).toBe('@main.ts')
    // 无分隔符的 ref:name 即自身;末尾分隔符产生空尾段(边界,真实 ref 不会)。
    expect(source.codec!.clipboardText('plain.ts')).toBe('@plain.ts')
    expect(source.codec!.clipboardText('C:\\p\\dir\\')).toBe('@')
  })

  it('codec serialize defaults unknown refs to a file reference', async () => {
    const { source } = makeHarness('C:\\ws\\p')
    await expect(source.codec!.serialize('C:\\ws\\p\\unpicked.ts', new AbortController().signal)).resolves
      .toBe('@unpicked.ts (C:\\ws\\p\\unpicked.ts)')
  })
})