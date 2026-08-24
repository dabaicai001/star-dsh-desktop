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
import { MSSQL, MySQL, PostgreSQL, SQLite, type SQLDialect } from '@codemirror/lang-sql'
import { autocompletion, completionKeymap, startCompletion, type CompletionSource } from '@codemirror/autocomplete'
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

/** 光标前语句最后一次出现的子句关键字,决定补全语境。 */
type ClauseKind = 'from' | 'where' | 'plain'

/** FROM/JOIN 等引入表名的关键字 → 之后补全表名。 */
const FROM_CLAUSE_KEYWORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE'])
/** WHERE 类子句关键字 → 之后补全列名(SELECT 列清单同样算列语境)。 */
const WHERE_CLAUSE_KEYWORDS = new Set(['WHERE', 'AND', 'OR', 'HAVING', 'ON', 'BETWEEN', 'IN', 'LIKE', 'IS', 'NOT', 'SET', 'BY', 'SELECT'])
/** WHERE 语境里与列并列展示的常用关键字(过滤方言关键字表后使用)。 */
const WHERE_CLAUSE_SUGGESTIONS = new Set([
  'AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'BETWEEN', 'LIKE', 'EXISTS',
  'ANY', 'ALL', 'SOME', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'TRUE', 'FALSE', 'ESCAPE',
])
/** 紧跟 FROM/JOIN 表名后的词若是这些子句关键字,不当作别名捕获。 */
const NON_ALIAS_WORDS = new Set([
  'WHERE', 'AND', 'OR', 'HAVING', 'ON', 'BETWEEN', 'IN', 'LIKE', 'IS', 'NOT', 'SET',
  'BY', 'SELECT', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'AS', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL',
])

/** 从 lang-sql 方言对象取关键字表(words 为内部字段,key 小写)。 */
function keywordsOf(dialect: SQLDialect): string[] {
  const words = (dialect as unknown as { dialect: { words: Record<string, number> } }).dialect.words
  return Object.keys(words).map(k => k.toUpperCase())
}

/** 取光标前(剔除当前正在输入的半截词)最后一次出现的子句关键字,决定补全语境。 */
function clauseKind(textBefore: string, currentWord: string): ClauseKind {
  const stable = textBefore.slice(0, textBefore.length - currentWord.length)
  const re = /\b(FROM|JOIN|INTO|UPDATE|TABLE|WHERE|AND|OR|HAVING|ON|BETWEEN|IN|LIKE|IS|NOT|SET|BY|SELECT)\b/gi
  let last: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(stable)) !== null) {
    const kw = m[1]
    if (kw !== undefined) last = kw.toUpperCase()
  }
  if (last === null) return 'plain'
  if (FROM_CLAUSE_KEYWORDS.has(last)) return 'from'
  if (WHERE_CLAUSE_KEYWORDS.has(last)) return 'where'
  return 'plain'
}

/** 解析 FROM/JOIN 引入的表(含 AS 别名),给出作用域内的列与「别名→表」映射。 */
function analyzeScope(textBefore: string, schema: SqlCompletionSchema): { inScopeColumns: Set<string>; aliasToTable: Map<string, string> } {
  const aliasToTable = new Map<string, string>()
  const tables = new Set<string>()
  const re = /\b(?:FROM|JOIN)\s+([\w$]+)(?:\s+(?:AS\s+)?([\w$]+))?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(textBefore)) !== null) {
    const table = m[1]
    if (table === undefined) continue
    tables.add(table)
    const alias = m[2]
    if (alias !== undefined && !NON_ALIAS_WORDS.has(alias.toUpperCase())) aliasToTable.set(alias, table)
  }
  const inScopeColumns = new Set<string>()
  for (const t of tables) {
    const cols = schema[t] ?? schema[Object.keys(schema).find(k => k.toLowerCase() === t.toLowerCase()) ?? '']
    if (cols !== undefined) for (const c of cols) inScopeColumns.add(c)
  }
  return { inScopeColumns, aliasToTable }
}

/** 按前缀过滤并去重(大小写不敏感,列/关键字/表名冲突时保留先出现的)。 */
function filterOptions(candidates: Array<{ label: string; type: string }>, word: string): Array<{ label: string; type: string }> {
  const seen = new Set<string>()
  const out: Array<{ label: string; type: string }> = []
  for (const o of candidates) {
    const l = o.label.toLowerCase()
    if (!l.includes(word) || seen.has(l)) continue
    seen.add(l)
    out.push(o)
  }
  return out
}

/**
 * 表/列/关键字补全 source:每次补全触发时经 getSchema 读最新 schema(编辑器
 * extensions 只建一次,schema 随树展开异步增长,必须走引用而非快照)。
 * 按光标前的子句语境分派:
 * - 「表.」前缀(支持 FROM/JOIN 别名):只补该表的列;
 * - FROM/JOIN/INTO/UPDATE 之后:补表名(+ 关键字);
 * - WHERE/AND/OR/HAVING/ON/SET/BY/SELECT 等之后:补作用域内表的列
 *   (找不到 FROM 表时退回全部列)+ WHERE 常用关键字;
 * - 其余语境:关键字 + 表名 + 全部列。
 * schema 缺失时不补全。导出供单测直接驱动(CompletionContext)。 */
export function tableCompletion(getSchema: () => SqlCompletionSchema | undefined, keywords: string[] = []): CompletionSource {
  return (context) => {
    const schema = getSchema()
    if (schema === undefined) return null
    const textBefore = context.state.sliceDoc(0, context.pos)
    const { inScopeColumns, aliasToTable } = analyzeScope(textBefore, schema)
    // 「表.」前缀(别名经 aliasToTable 还原):只补该表的列(from 定位到 . 之后)。
    const dot = context.matchBefore(/([\w$]+)\.([\w$-]*)$/)
    if (dot !== null) {
      const raw = dot.text.slice(0, dot.text.indexOf('.'))
      const table = aliasToTable.get(raw) ?? raw
      const cols = schema[table] ?? schema[Object.keys(schema).find(t => t.toLowerCase() === table.toLowerCase()) ?? '']
      if (cols === undefined || cols.length === 0) return null
      const prefix = dot.text.slice(dot.text.indexOf('.') + 1).toLowerCase()
      const options = cols
        .filter(c => c.toLowerCase().includes(prefix))
        .map(c => ({ label: c, type: 'property' }))
      if (options.length === 0) return null
      return { from: dot.from + raw.length + 1, options, validFor: /^[\w$-]*$/ }
    }
    const before = context.matchBefore(/[\w$-]*/)
    if (before === null) return null
    if (before.from === before.to && !context.explicit) return null
    const word = before.text.toLowerCase()
    const kind = clauseKind(textBefore, before.text)
    const allTables = Object.keys(schema)
    const allColumns = new Set<string>()
    for (const cols of Object.values(schema)) for (const c of cols) allColumns.add(c)
    let candidates: Array<{ label: string; type: string }>
    if (kind === 'from') {
      candidates = [
        ...allTables.map(t => ({ label: t, type: 'class' })),
        ...keywords.map(k => ({ label: k, type: 'keyword' })),
      ]
    } else if (kind === 'where') {
      const scope = inScopeColumns.size > 0 ? inScopeColumns : allColumns
      candidates = [
        ...[...scope].map(c => ({ label: c, type: 'property' })),
        ...keywords.filter(k => WHERE_CLAUSE_SUGGESTIONS.has(k)).map(k => ({ label: k, type: 'keyword' })),
      ]
    } else {
      candidates = [
        ...keywords.map(k => ({ label: k, type: 'keyword' })),
        ...allTables.map(t => ({ label: t, type: 'class' })),
        ...[...allColumns].map(c => ({ label: c, type: 'property' })),
      ]
    }
    const options = filterOptions(candidates, word)
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
  const keywords = keywordsOf(dialect)
  const onExecute = opts.onExecute
  const executeKeymap = onExecute === undefined ? [] : [
    { key: 'Mod-Enter', run: () => { onExecute(viewValue(opts.viewRef), false); return true } },
    { key: 'Shift-Mod-e', run: () => { onExecute(viewValue(opts.viewRef), true); return true } },
  ]
  // 空格后自动弹出补全:光标前刚敲完 WHERE/AND/OR 等子句关键字时,立即提示可用列
  // (跳过行注释与未闭合字符串,避免在注释/字面量里误弹)。
  const spaceHintKeymap = [
    {
      key: 'Space',
      run: (view: EditorView): boolean => {
        const head = view.state.selection.main.head
        const before = view.state.sliceDoc(0, head)
        const m = before.match(/([A-Za-z_$][\w$]*)\s*$/)
        if (m === null || m[1] === undefined) return false
        if (!/^(WHERE|AND|OR|HAVING|ON|BETWEEN|LIKE|IN|SET|BY|SELECT)$/i.test(m[1])) return false
        const lineFrom = view.state.doc.lineAt(head).from
        const lineHead = view.state.sliceDoc(lineFrom, head)
        if (lineHead.includes('--')) return false
        const quotes = (lineHead.match(/'/g) ?? []).length + (lineHead.match(/"/g) ?? []).length
        if (quotes % 2 !== 0) return false
        view.dispatch(view.state.replaceSelection(' '))
        startCompletion(view)
        return true
      },
    },
  ]
  return [
    language,
    history(),
    // 关键字 + 表/列(自定义 source 读最新 schema,并按子句语境分派);override 不能省,
    // 否则缺 schema 配置时 lang-sql 默认 source 也不会给出关键字补全。
    autocompletion({
      override: [tableCompletion(opts.getSchema, keywords)],
    }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, ...spaceHintKeymap, indentWithTab, ...executeKeymap]),
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
