/**
 * SQL 文本纯函数工具(需求 5 React 化,批次 5):多语句拆分 + 基础格式化。
 *
 * - `splitStatements(sql)`:按分号拆多条语句,忽略字符串/单引号内/行注释里的
 *   分号;返回去掉空白的语句数组(与 Vue 端「一次执行一条」的交互模型对齐,
 *   DbWorkbench 执行前用它对多语句做拆分)。
 * - `formatSql(sql)`:轻量美化——大关键字(保留字)统一大写,主要子句
 *   (SELECT/FROM/WHERE/GROUP BY/ORDER BY/LIMIT/INSERT/UPDATE/SET/VALUES/
 *   JOIN/LEFT JOIN/INNER JOIN/HAVING/UNION/ON)前换行缩进,单引号字符串与
 *   反引号标识符原样保留(不拆词、不伤字符串内容)。目标不是完整 SQL 格式化
 *   器,而是让手写多行 SQL 的可读性一致化。
 *
 * 纯函数,无 DOM/Tauri 依赖,便于 100% 覆盖测试。
 *
 * @module StarHub SQL text utils (client)
 */

/** 主要子句关键字(格式化时在其前换行);按词首匹配(大小写不敏感),
 * 避免命中普通列名。长词在前,确保 INSERT INTO 优先于 INSERT。 */
const CLAUSE_KEYWORDS = [
  'INSERT INTO', 'DELETE FROM', 'GROUP BY', 'ORDER BY', 'UNION ALL', 'LEFT JOIN',
  'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'SELECT', 'FROM', 'WHERE', 'HAVING',
  'LIMIT', 'OFFSET', 'UPDATE', 'INSERT', 'DELETE', 'SET', 'VALUES', 'JOIN',
  'UNION', 'ON',
] as const

/** 单行注释起点:出现在行注释或字符串外时,其后到行尾视为注释。 */
function findLineCommentEnd(sql: string, from: number): number {
  const newline = sql.indexOf('\n', from)
  return newline === -1 ? sql.length : newline
}

/**
 * Split SQL text into individual statements on top-level semicolons.
 * @param sql - the raw SQL text (may contain comments / string literals).
 * @returns non-empty trimmed statements; empty input yields an empty array.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let current = ''
  let inSingle = false
  let inBacktick = false
  let i = 0
  while (i < sql.length) {
    const ch = sql.charAt(i)
    if (!inSingle && !inBacktick && ch === '-' && sql[i + 1] === '-') {
      // 行注释:吞到行尾,不分号切分。
      const end = findLineCommentEnd(sql, i + 2)
      if (current !== '' && current.trim() !== '') {
        current += sql.slice(i, end)
      }
      i = end
      continue
    }
    if (!inBacktick && ch === "'") {
      inSingle = !inSingle
      current += ch
      i += 1
      continue
    }
    if (!inSingle && ch === '`') {
      inBacktick = !inBacktick
      current += ch
      i += 1
      continue
    }
    if (!inSingle && !inBacktick && ch === ';') {
      const trimmed = current.trim()
      if (trimmed !== '') out.push(trimmed)
      current = ''
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  const tail = current.trim()
  if (tail !== '') out.push(tail)
  return out
}

/** 关键字跨度 [start, end) 是否为独立词:start 前与 end 后都不是标识符字符。 */
function isWordBoundary(sql: string, start: number, end: number): boolean {
  // v8 ignore next -- 防御:noUncheckedIndexedAccess 静态类型兜底,start>0 时下标恒有效
  const before = start > 0 ? (sql[start - 1] ?? ' ') : ' '
  // v8 ignore next -- 防御:同上,end<length 时下标恒有效
  const after = end < sql.length ? (sql[end] ?? ' ') : ' '
  return !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)
}

/**
 * Lightweight SQL pretty-printer: uppercases clause keywords and adds a newline
 * (plus two-space indent) before each major clause, preserving string literals.
 * @param sql - the raw SQL text.
 * @returns formatted SQL; empty input returns the input unchanged.
 */
export function formatSql(sql: string): string {
  if (sql.trim() === '') return sql
  let out = ''
  let inSingle = false
  let inBacktick = false
  let i = 0
  let pendingNewline = false
  while (i < sql.length) {
    const ch = sql.charAt(i)
    // 字符串/标识符原样透传(不换行、不大写)。
    if (ch === "'" && !inBacktick) {
      inSingle = !inSingle
      out += ch
      i += 1
      continue
    }
    if (ch === '`' && !inSingle) {
      inBacktick = !inBacktick
      out += ch
      i += 1
      continue
    }
    if (!inSingle && !inBacktick && ch === '-' && sql[i + 1] === '-') {
      const end = findLineCommentEnd(sql, i + 2)
      out += sql.slice(i, end)
      i = end
      pendingNewline = true
      continue
    }
    if (inSingle || inBacktick) {
      out += ch
      i += 1
      continue
    }
    // 关键字匹配:尝试在当前位置匹配任一子句关键字(词首匹配,大小写不敏感)。
    let matched: string | null = null
    for (const kw of CLAUSE_KEYWORDS) {
      if (sql.slice(i, i + kw.length).toUpperCase() === kw
        && isWordBoundary(sql, i, i + kw.length)) {
        matched = kw
        break
      }
    }
    if (matched !== null) {
      if (out.trimEnd() !== '') {
        // 子句前换行(首个关键字不换,保持开头整洁)。
        out = out.replace(/\s+$/, '')
        out += '\n  '
      }
      out += matched
      i += matched.length
      pendingNewline = false
      continue
    }
    // 普通字符;行注释后紧跟的换行交给原样透传。
    out += ch
    i += 1
    if (pendingNewline && ch === '\n') pendingNewline = false
  }
  return out
}
