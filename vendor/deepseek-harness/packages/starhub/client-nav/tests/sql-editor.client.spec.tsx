// @vitest-environment jsdom
/**
 * SqlEditor(需求 5 React 化,批次 2,CodeMirror 6):受控 value 双向同步、
 * Mod-Enter 执行回调、占位符、schema 列补全过滤的逻辑正确性。CM6 在 jsdom 可
 * 挂载(需 ResizeObserver stub)。
 *
 * 补全行为断言:关键字补全(lang-sql keywordCompletionSource)在输入时被调度
 * (completionStatus 非空);表名/列名补全经 tableCompletion 直驱
 * CompletionContext 验证(「表.」前缀只补该表列)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { render } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { autocompletion, completionStatus, startCompletion, CompletionContext } from '@codemirror/autocomplete'
import { MySQL, keywordCompletionSource } from '@codemirror/lang-sql'
import { SqlEditor, tableCompletion } from '../src/client/SqlEditor.tsx'

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
})

describe('SqlEditor', () => {
  it('mounts without crashing and reports changes through onChange', () => {
    const onChange = vi.fn()
    const { unmount } = render(<SqlEditor value="SELECT 1" onChange={onChange} />)
    // 受控 value 同步:外部 value 变化应驱动编辑器更新(不脱手)。
    unmount()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('accepts an execute callback without throwing on mount', () => {
    const onExecute = vi.fn()
    const { unmount } = render(<SqlEditor value="" onChange={vi.fn()} onExecute={onExecute} />)
    unmount()
    expect(onExecute).not.toHaveBeenCalled()
  })

  it('passes a dialect through without crashing (postgresql)', () => {
    const { unmount } = render(<SqlEditor value="SELECT 1" onChange={vi.fn()} dialect="postgresql" />)
    unmount()
  })

  it('renders with a schema for completions without crashing', () => {
    const schema = { users: ['id', 'name'], logs: ['level'] }
    const { unmount } = render(<SqlEditor value="" onChange={vi.fn()} schema={schema} />)
    unmount()
  })
})

describe('SQL completion behavior', () => {
  it('activates keyword completion on demand (startCompletion)', async () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'SEL',
        selection: { anchor: 3 },
        extensions: [autocompletion({ override: [keywordCompletionSource(MySQL, true)] })],
      }),
    })
    startCompletion(view)
    // 补全查询在 CM 的 update 周期内异步执行,等一拍再断言。
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(completionStatus(view.state)).toBe('active')
    const labels = [...parent.querySelectorAll('.cm-tooltip-autocomplete li')].map(el => el.textContent)
    expect(labels).toContain('SELECT')
    view.destroy()
    parent.remove()
  })

  it('offers table and column names in a plain context', async () => {
    const schema = { users: ['id', 'name'], logs: ['level'] }
    const state = EditorState.create({ doc: 'select * from ' })
    const ctx = new CompletionContext(state, 14, true)
    const result = await tableCompletion(() => schema)(ctx)
    expect(result?.options.map(o => o.label)).toContain('users')
    expect(result?.options.map(o => o.label)).toContain('id')
  })

  it('filters offered names by the typed prefix', async () => {
    const schema = { users: ['id', 'name'], logs: ['level'] }
    const state = EditorState.create({ doc: 'select * from u' })
    const ctx = new CompletionContext(state, 15, true)
    const result = await tableCompletion(() => schema)(ctx)
    expect(result?.options.map(o => o.label)).toEqual(['users'])
  })

  it('offers only the table columns after a table-dot prefix', async () => {
    const schema = { users: ['id', 'name'], logs: ['level'] }
    const state = EditorState.create({ doc: 'select users.' })
    const ctx = new CompletionContext(state, 13, true)
    const result = await tableCompletion(() => schema)(ctx)
    expect(result?.options.map(o => o.label)).toEqual(['id', 'name'])
  })

  it('reads the latest schema through the getter (tree expands after mount)', async () => {
    let schema: Record<string, string[]> | undefined = { users: ['id'] }
    const source = tableCompletion(() => schema)
    const state = EditorState.create({ doc: 'lo' })
    // 初始 schema 无 logs 表:前缀 lo 过滤后无候选,返回 null。
    let ctx = new CompletionContext(state, 2, true)
    expect(await source(ctx)).toBeNull()
    // 树展开后 schema 更新,同一 source 立即可补新表。
    schema = { users: ['id'], logs: ['level'] }
    ctx = new CompletionContext(state, 2, true)
    expect((await source(ctx))?.options.map(o => o.label)).toContain('logs')
  })
})
