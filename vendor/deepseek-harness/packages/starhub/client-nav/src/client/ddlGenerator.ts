/**
 * StarHub DB DDL 生成器(批次 4b):从 Vue `src/utils/ddlGenerator.ts` 移植的纯函数
 * 集合,用于生成 MySQL / PostgreSQL / ClickHouse 的建表、批量改列、批量索引 DDL。
 * 与 Vue 端保持行为一致,供 React 对话框(NewTableDialog / ColumnListDialog /
 * IndexListDialog)复用。命令面仍走 `db_mysql_execute`(PG 复用,clickhouse 用
 * `db_clickhouse_execute`)。
 *
 * @module StarHub DB DDL generator (client)
 */

/** 列元数据(与 Vue src/types/db.ts 的 ColumnMeta 同构;由 list_columns 返回)。 */
export interface ColumnMeta {
  name: string
  type: string
  dataType: string
  nullable: string
  key: string
  defaultValue: string | null
  extra: string
  comment: string
  ordinalPosition: number
}

/** 索引元数据(与 Vue src/types/db.ts 的 IndexInfo 同构;由 list_indexes 返回)。 */
export interface IndexInfo {
  tableName: string
  nonUnique: number
  keyName: string
  seqInIndex: number
  columnName: string
  collation: string
  cardinality: number | null
  subPart: number | null
  packed: string | null
  null: string
  indexType: string
  comment: string
  indexComment: string
  visible: string
  expression: string | null
}

function quoteIdent(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

/** 单列的可编辑形态:在原始列元数据上叠加新值、脏标记与删除标记。 */
export interface ColumnEdit extends ColumnMeta {
  newName: string
  newType: string
  newNullable: boolean
  newDefault: string
  newComment: string
  dirty: boolean
  dropped: boolean
}

/**
 * 生成批量改列的单条 ALTER TABLE 语句(ADD / MODIFY / CHANGE / DROP 合并)。
 * @param db - 库名。
 * @param table - 表名。
 * @param originalCols - 服务器上的原始列。
 * @param edits - 编辑后的列集合。
 * @returns 语句数组;无变更时返回空数组。
 */
export function generateBatchColumnDDL(
  db: string,
  table: string,
  originalCols: ColumnMeta[],
  edits: ColumnEdit[],
): string[] {
  const parts: string[] = []
  const originalNames = new Set(originalCols.map(c => c.name))

  // ADD COLUMN (新增的列,不在 originalCols 中)
  for (const col of edits) {
    if (!originalNames.has(col.name) && !col.dropped) {
      parts.push(buildColumnDef(col.newName, col))
      continue
    }
  }

  // MODIFY / CHANGE / DROP
  for (const col of edits) {
    if (!originalNames.has(col.name)) continue
    if (col.dropped) {
      parts.push(`DROP COLUMN \`${col.name}\``)
      continue
    }
    if (!col.dirty) continue
    if (col.newName !== col.name) {
      parts.push(`CHANGE COLUMN \`${col.name}\` \`${col.newName}\` ${buildColumnTypeDef(col)}`)
    } else {
      parts.push(`MODIFY COLUMN \`${col.name}\` ${buildColumnTypeDef(col)}`)
    }
  }

  if (parts.length === 0) return []
  return [`ALTER TABLE \`${db}\`.\`${table}\`\n  ${parts.join(',\n  ')}`]
}

function buildColumnDef(name: string, col: ColumnEdit): string {
  return `ADD COLUMN \`${name}\` ${buildColumnTypeDef(col)}`
}

function buildColumnTypeDef(col: ColumnEdit): string {
  const typeStr = col.newType.trim()
  const nullStr = col.newNullable ? 'NULL' : 'NOT NULL'
  let defStr = ''
  if (col.newDefault !== '') {
    const isNum = /^-?\d+(\.\d+)?$/.test(col.newDefault)
    defStr = ` DEFAULT ${isNum ? col.newDefault : `'${col.newDefault.replace(/'/g, "''")}'`}`
  }
  const commentStr = col.newComment ? ` COMMENT '${col.newComment.replace(/'/g, "''")}'` : ''
  return `${typeStr} ${nullStr}${defStr}${commentStr}`
}

/**
 * 生成单列新增语句(ADD COLUMN,可带 AFTER)。
 * @param db - 库名。
 * @param table - 表名。
 * @param name - 列名。
 * @param type - 列类型(可含长度/精度)。
 * @param nullable - 是否允许 NULL。
 * @param defaultValue - 默认值(空串表示无默认值)。
 * @param comment - 列注释(空串表示无注释)。
 * @param after - 可选的 AFTER 定位列。
 * @returns 单条 ALTER TABLE ADD COLUMN 语句。
 */
export function generateAddColumnDDL(
  db: string,
  table: string,
  name: string,
  type: string,
  nullable: boolean,
  defaultValue: string,
  comment: string,
  after?: string,
): string {
  const col: ColumnEdit = {
    name, newName: name, type, newType: type,
    dataType: '', nullable: nullable ? 'YES' : 'NO', newNullable: nullable,
    key: '', defaultValue: null, newDefault: defaultValue,
    extra: '', comment: '', newComment: comment,
    ordinalPosition: 0, dirty: true, dropped: false,
  }
  let sql = `ALTER TABLE \`${db}\`.\`${table}\` ADD COLUMN \`${name}\` ${buildColumnTypeDef(col)}`
  if (after) sql += ` AFTER \`${after}\``
  return sql
}

/**
 * 生成单列修改语句(MODIFY COLUMN)。
 * @param db - 库名。
 * @param table - 表名。
 * @param name - 列名。
 * @param type - 列类型(可含长度/精度)。
 * @param nullable - 是否允许 NULL。
 * @param defaultValue - 默认值(空串表示无默认值)。
 * @param comment - 列注释(空串表示无注释)。
 * @returns 单条 ALTER TABLE MODIFY COLUMN 语句。
 */
export function generateModifyColumnDDL(
  db: string,
  table: string,
  name: string,
  type: string,
  nullable: boolean,
  defaultValue: string,
  comment: string,
): string {
  const col: ColumnEdit = {
    name, newName: name, type, newType: type,
    dataType: '', nullable: nullable ? 'YES' : 'NO', newNullable: nullable,
    key: '', defaultValue: null, newDefault: defaultValue,
    extra: '', comment: '', newComment: comment,
    ordinalPosition: 0, dirty: true, dropped: false,
  }
  return `ALTER TABLE ${quoteIdent(db)}.${quoteIdent(table)} MODIFY COLUMN ${quoteIdent(name)} ${buildColumnTypeDef(col)}`
}

/**
 * 生成单列删除语句(DROP COLUMN)。
 * @param db - 库名。
 * @param table - 表名。
 * @param name - 列名。
 * @returns 单条 ALTER TABLE DROP COLUMN 语句。
 */
export function generateDropColumnDDL(db: string, table: string, name: string): string {
  return `ALTER TABLE \`${db}\`.\`${table}\` DROP COLUMN \`${name}\``
}

/**
 * 生成单条 CREATE INDEX 语句。
 * @param db - 库名。
 * @param table - 表名。
 * @param indexName - 索引名。
 * @param columns - 索引列名数组。
 * @param unique - 是否唯一索引。
 * @param indexType - 索引类型(如 BTREE / HASH;空串回退 BTREE)。
 * @returns CREATE [UNIQUE] INDEX ... USING <type> 语句。
 */
export function generateCreateIndexDDL(
  db: string,
  table: string,
  indexName: string,
  columns: string[],
  unique: boolean,
  indexType: string,
): string {
  const uniqueStr = unique ? 'UNIQUE ' : ''
  const cols = columns.map(c => `\`${c}\``).join(', ')
  return `CREATE ${uniqueStr}INDEX \`${indexName}\` ON \`${db}\`.\`${table}\` (${cols}) USING ${indexType || 'BTREE'}`
}

/**
 * 生成单条 DROP INDEX 语句。
 * @param db - 库名。
 * @param table - 表名。
 * @param indexName - 索引名。
 * @returns 单条 DROP INDEX ON 语句。
 */
export function generateDropIndexDDL(db: string, table: string, indexName: string): string {
  return `DROP INDEX \`${indexName}\` ON ${quoteIdent(db)}.${quoteIdent(table)}`
}

/** 索引的可编辑形态:叠加新值、脏标记、删除标记与「本会话新增」标记。 */
export interface IndexEdit {
  name: string
  newName: string
  columns: string       // comma-separated
  newColumns: string    // comma-separated
  unique: boolean
  newUnique: boolean
  indexType: string
  newIndexType: string
  dirty: boolean
  dropped: boolean
  /** true 表示本会话新增的索引,服务器上尚不存在,应用变更时不能对其生成 DROP INDEX(否则 MySQL Error 1091)。 */
  isNew: boolean
}

function splitCols(s: string): string[] {
  return s.split(',').map(c => c.trim()).filter(Boolean)
}

// ====== 新建表(方言感知) ======

/** 建表支持的方言类型。 */
export type CreateTableDbType = 'mysql' | 'postgresql' | 'clickhouse'

/** 建表时的单列定义。 */
export interface CreateTableColumn {
  name: string
  type: string
  /** 长度 / 精度,如 '255' 或 '10,2';留空时 VARCHAR/CHAR 自动补 255。 */
  size: string
  nullable: boolean
  primaryKey: boolean
  defaultValue: string
  comment: string
}

/** 建表选项。 */
export interface CreateTableOptions {
  dbType: CreateTableDbType
  database: string
  table: string
  columns: CreateTableColumn[]
  /** MySQL: InnoDB 等;ClickHouse: MergeTree 等;PG 忽略。 */
  engine?: string
  /** 仅 MySQL。 */
  charset?: string
  tableComment?: string
}

function quoteDialectIdent(dbType: CreateTableDbType, name: string): string {
  if (dbType === 'postgresql') return '"' + name.replace(/"/g, '""') + '"'
  return '`' + name.replace(/`/g, '``') + '`'
}

/** 需要长度/精度的类型(未自带括号且未填 size 时需要兜底)。 */
const SIZE_REQUIRED_DEFAULTS: Record<string, string> = {
  VARCHAR: '255',
  CHAR: '1',
  VARBINARY: '255',
  BINARY: '1',
}

/**
 * 渲染列类型(含长度/精度):type 自带括号时原样;size 合法时拼 TYPE(size);
 * VARCHAR/CHAR 缺 size 时用兜底长度避免 MySQL Error 1064。
 * @param type - 列类型(可含括号与字体大小写)。
 * @param size - 长度/精度字符串。
 * @returns 渲染后的类型字符串。
 */
export function renderColumnType(type: string, size: string): string {
  const raw = type.trim()
  const upper = raw.toUpperCase()
  if (raw.includes('(')) return raw
  const s = size.trim()
  if (s) {
    if (!/^\d+(\s*,\s*\d+)?$/.test(s)) {
      throw new Error(`invalid column size: ${s}`)
    }
    return `${raw}(${s.replace(/\s+/g, '')})`
  }
  const fallback = SIZE_REQUIRED_DEFAULTS[upper]
  return fallback ? `${raw}(${fallback})` : raw
}

function formatCreateDefault(defaultValue: string): string {
  if (defaultValue === '') return ''
  const v = defaultValue.trim()
  const isNum = /^-?\d+(\.\d+)?$/.test(v)
  const isFunc = /^(CURRENT_TIMESTAMP|NOW\(\)|CURRENT_DATE|CURRENT_TIME|NULL|TRUE|FALSE)$/i.test(v)
  return ` DEFAULT ${isNum || isFunc ? v : `'${v.replace(/'/g, "''")}'`}`
}

/**
 * 生成建表语句数组。PG 的列/表注释会拆成独立的 COMMENT ON 语句,其余方言为单条
 * CREATE TABLE。
 * @param opts - 建表选项(方言 / 库名 / 表名 / 列定义等)。
 * @returns 待执行的语句数组(逐条经 execute 运行)。
 */
export function generateCreateTableDDL(opts: CreateTableOptions): string[] {
  const { dbType, database, table, columns } = opts
  const q = (n: string) => quoteDialectIdent(dbType, n)
  const qualified = `${q(database)}.${q(table)}`
  const commentStmts: string[] = []

  const colDefs = columns.map((c) => {
    const rendered = renderColumnType(c.type, c.size)
    if (dbType === 'clickhouse') {
      // ClickHouse 默认非空,可空要用 Nullable(T) 包装,不支持 NOT NULL / 列级 PK。
      const chType = c.nullable ? `Nullable(${rendered})` : rendered
      let def = `${q(c.name)} ${chType}${formatCreateDefault(c.defaultValue)}`
      if (c.comment) def += ` COMMENT '${c.comment.replace(/'/g, "''")}'`
      return def
    }
    let def = `${q(c.name)} ${rendered}`
    def += c.nullable ? ' NULL' : ' NOT NULL'
    def += formatCreateDefault(c.defaultValue)
    if (c.comment) {
      if (dbType === 'postgresql') {
        commentStmts.push(
          `COMMENT ON COLUMN ${qualified}.${q(c.name)} IS '${c.comment.replace(/'/g, "''")}'`,
        )
      } else {
        def += ` COMMENT '${c.comment.replace(/'/g, "''")}'`
      }
    }
    return def
  })

  const pkCols = columns.filter(c => c.primaryKey).map(c => q(c.name))
  let ddl: string

  if (dbType === 'clickhouse') {
    const engine = (opts.engine || 'MergeTree').trim()
    // MergeTree 家族必须有 ORDER BY;无主键时退化为 tuple()。
    const orderBy = pkCols.length > 0 ? `(${pkCols.join(', ')})` : 'tuple()'
    ddl = `CREATE TABLE ${qualified} (\n  ${colDefs.join(',\n  ')}\n)\nENGINE = ${engine}()\nORDER BY ${orderBy}`
    if (opts.tableComment) {
      ddl += `\nCOMMENT '${opts.tableComment.replace(/'/g, "''")}'`
    }
  } else {
    const parts = [...colDefs]
    if (pkCols.length > 0) parts.push(`PRIMARY KEY (${pkCols.join(', ')})`)
    ddl = `CREATE TABLE ${qualified} (\n  ${parts.join(',\n  ')}\n)`
    if (dbType === 'mysql') {
      ddl += ` ENGINE=${opts.engine || 'InnoDB'}`
      ddl += ` DEFAULT CHARSET=${opts.charset || 'utf8mb4'}`
      if (opts.tableComment) {
        ddl += ` COMMENT='${opts.tableComment.replace(/'/g, "\\'")}'`
      }
    } else if (opts.tableComment) {
      commentStmts.push(`COMMENT ON TABLE ${qualified} IS '${opts.tableComment.replace(/'/g, "''")}'`)
    }
  }

  return [ddl, ...commentStmts]
}

/**
 * 生成批量索引变更的语句数组:先 DROP(含脏索引重建),再 CREATE 新增/修改;
 * 会话新增(isNew)的索引不生成 DROP,避免 MySQL Error 1091。
 * @param db - 库名。
 * @param table - 表名。
 * @param edits - 编辑后的索引集合。
 * @returns 待执行的语句数组。
 */
export function generateBatchIndexDDL(db: string, table: string, edits: IndexEdit[]): string[] {
  const ddls: string[] = []
  // 先处理删除(isNew 的索引服务器上不存在,DROP 会报 Error 1091)。
  for (const e of edits) {
    if (e.isNew) continue
    if (e.dropped || e.dirty) {
      ddls.push(generateDropIndexDDL(db, table, e.name))
    }
  }
  // 再处理新增/修改。
  for (const e of edits) {
    if (!e.dropped && e.dirty) {
      ddls.push(generateCreateIndexDDL(db, table, e.newName, splitCols(e.newColumns), e.newUnique, e.newIndexType))
    }
  }
  return ddls
}
