/**
 * StarHub 原生 SQL 编辑器(需求 5 React 化,批次 2),基于 CodeMirror 6。
 *
 * 对齐 Vue SqlEditor 的能力集:
 * - 语法高亮:@codemirror/lang-sql(MySQL / PostgreSQL 方言,Redis 无方言)。
 * - 补全:关键字补全走 lang-sql `keywordCompletionSource`;表名/列名走自定义
 *   source(支持「表.列」前缀),schema 由父组件传入 `columnsByTable`(与 Vue 的
 *   sqlCompletionSchema 同构),经 ref 惰性读取,树展开后新表立即参与补全。
 * - 快捷键:Mod-Enter 执行、Shift-Mod-e EXPLAIN、indentWithTab。
 * - 只读/可写、内容受控(受控 value + onChange)。
 *
 * CM6 依赖与 Vue 同款(@codemirror/state/view/lang-sql/autocomplete/commands),
 * shell bundle 已含 xterm 先例,第三方编辑器库可正常打包。
 *
 * @module StarHub SQL editor (client)
 */

import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { MSSQL, MySQL, PostgreSQL, SQLite, keywordCompletionSource, type SQLDialect } from '@codemirror/lang-sql'
import { autocompletion, completionKeymap, type CompletionSource } from '@codemirror/autocomplete'
import css from './SqlEditor.module.css'

/** 表 → 列名映射(补全 schema;与 Vue 端 sqlCompletionSchema 同构)。 */
export interface SqlCompletionSchema {
  [table: string]: string[]
}

/** 编辑器方言。 */
export type SqlDialect = 'mysql' | 'postgresql' | 'sqlite' | 'mssql'

/** SQL 编辑器 props。 */
export interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  /** 补全 schema(表→列);缺省禁用表/列补全。 */
  schema?: SqlCompletionSchema
  dialect?: SqlDialect
  /** 执行回调(Mod-Enter);返回 Promise 以便编辑器知道执行中。 */
  onExecute?: (sql: string, explain: boolean) => void
  placeholder?: string
}

/** 方言 key → lang-sql 方言对象(补全/高亮共用)。 */
function dialectOf(dialect: SqlDialect): SQLDialect {
  switch (dialect) {
    case 'postgresql': return PostgreSQL
    case 'sqlite': return SQLite
    case 'mssql': return MSSQL
    default: return MySQL
  }
}

/** 表/列补全 source:每次补全触发时经 getSchema 读最新 schema(编辑器 extensions
 * 只建一次,schema 随树展开异步增长,必须走引用而非快照)。
 * - 「表.」前缀:补该表列名;
 * - 其余语境:补全表名 + 全部列名。schema 缺失时不补全。
 * 导出供单测直接驱动(CompletionContext)。 */
export function tableCompletion(getSchema: () => SqlCompletionSchema | undefined): CompletionSource {
  return (context) => {
    const schema = getSchema()
    if (schema === undefined) return null
    // 「表.」前缀:只补该表的列(from 定位到 . 之后)。
    const dot = context.matchBefore(/([\w$]+)\.([\w$-]*)$/)
    if (dot !== null) {
      const table = dot.text.slice(0, dot.text.indexOf('.'))
      const cols = schema[table] ?? schema[Object.keys(schema).find(t => t.toLowerCase() === table.toLowerCase()) ?? '']
      if (cols === undefined || cols.length === 0) return null
      const prefix = dot.text.slice(dot.text.indexOf('.') + 1).toLowerCase()
      const options = cols
        .filter(c => c.toLowerCase().includes(prefix))
        .map(c => ({ label: c, type: 'property' }))
      if (options.length === 0) return null
      return { from: dot.from + table.length + 1, options, validFor: /^[\w$-]*$/ }
    }
    const before = context.matchBefore(/[\w$-]*/)
    if (before === null) return null
    if (before.from === before.to && !context.explicit) return null
    const word = before.text.toLowerCase()
    const allColumns = new Set<string>()
    for (const cols of Object.values(schema)) for (const c of cols) allColumns.add(c)
    const options = [
      ...Object.keys(schema).map(t => ({ label: t, type: 'class' })),
      ...[...allColumns].map(c => ({ label: c, type: 'property' })),
    ].filter(o => o.label.toLowerCase().includes(word))
    if (options.length === 0) return null
    return { from: before.from, options, validFor: /^[\w$-]*$/ }
  }
}

/** 构造 CM6 extensions(在组件外缓存纯函数,避免每次渲染重建)。 */
function buildExtensions(opts: {
  value: string
  onChange: (v: string) => void
  /** 惰性取最新补全 schema(表树异步展开,schema 持续增长)。 */
  getSchema: () => SqlCompletionSchema | undefined
  dialect?: SqlDialect
  onExecute?: (sql: string, explain: boolean) => void
  placeholder?: string
  viewRef: { current: EditorView | null }
}): Extension[] {
  const dialect = dialectOf(opts.dialect ?? 'mysql')
  const language = dialect
  const onExecute = opts.onExecute
  const executeKeymap = onExecute === undefined ? [] : [
    { key: 'Mod-Enter', run: () => { onExecute(viewValue(opts.viewRef), false); return true } },
    { key: 'Shift-Mod-e', run: () => { onExecute(viewValue(opts.viewRef), true); return true } },
  ]
  return [
    language,
    history(),
    // 关键字(lang-sql)+ 表/列(自定义,读最新 schema);override 不能省,
    // 否则缺 schema 配置时 lang-sql 默认 source 也不会给出关键字补全。
    autocompletion({
      override: [keywordCompletionSource(dialect, true), tableCompletion(opts.getSchema)],
    }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab, ...executeKeymap]),
    EditorView.lineWrapping,
    cmPlaceholder(opts.placeholder ?? '输入 SQL,Mod-Enter 执行'),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString())
    }),
  ]
}

/** 从当前 EditorView 取全文(M-fold:用于快捷键回调拿最新值)。 */
function viewValue(ref: { current: EditorView | null }): string {
  return ref.current?.state.doc.toString() ?? ''
}

/**
 * Render a CodeMirror 6 SQL editor with schema-aware completion and the
 * StarHub execute keybinds (Mod-Enter / Shift-Mod-e).
 * @param props - controlled value, schema, dialect, execute callback.
 * @returns the editor mounting div.
 */
export function SqlEditor({ value, onChange, schema, dialect = 'mysql', onExecute, placeholder }: SqlEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // 补全 schema 走 ref:extensions 只建一次,树展开后新表/列也要能补全。
  const schemaRef = useRef(schema)
  schemaRef.current = schema

  // 建一次 view(严格模式双跑由 dispose 抵消)。
  useEffect(() => {
    if (hostRef.current === null) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: buildExtensions({
          value, onChange, dialect, viewRef,
          getSchema: () => schemaRef.current,
          ...(onExecute !== undefined ? { onExecute } : {}),
          ...(placeholder !== undefined ? { placeholder } : {}),
        }),
      }),
    })
    viewRef.current = view
    const host = hostRef.current
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() =>{  view.requestMeasure() })
      ro.observe(host)
      return () => {
        ro.disconnect()
        view.destroy()
        viewRef.current = null
      }
    }
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 只建一次;外部 value 同步走下方 effect。buildExtensions 依赖变化由
    // 下方 dispatch 覆盖(受控文本)。
  }, [])

  // 受控 value 同步:外部变化时更新编辑器(避免光标重置:仅当 doc 不同才 replace)。
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} className={css.editor} />
}

export default SqlEditor
