// @vitest-environment node
/**
 * ddlGenerator(批次 4b):从 Vue tests/utils/ddlGenerator.test.mjs 移植的 vitest 版,
 * 覆盖 generateCreateTableDDL / generateBatchColumnDDL / generateBatchIndexDDL 等
 * 纯函数的 MySQL / PostgreSQL / ClickHouse 方言输出。
 */
import { describe, expect, it } from 'vitest'
import {
  generateAddColumnDDL,
  generateBatchColumnDDL,
  generateBatchIndexDDL,
  generateCreateIndexDDL,
  generateCreateTableDDL,
  generateDropColumnDDL,
  generateDropIndexDDL,
  generateModifyColumnDDL,
  renderColumnType,
  type ColumnEdit,
  type ColumnMeta,
} from '../src/client/ddlGenerator.ts'

function makeCol(overrides: Partial<ColumnEdit> = {}): ColumnEdit {
  return {
    name: 'col1', newName: 'col1', type: 'VARCHAR(255)', newType: 'VARCHAR(255)',
    dataType: 'varchar', nullable: 'YES', newNullable: true, key: '',
    defaultValue: null, newDefault: '', extra: '', comment: '', newComment: '',
    ordinalPosition: 1, dirty: false, dropped: false, ...overrides,
  }
}

function makeMeta(name: string): ColumnMeta {
  return {
    name, type: 'VARCHAR(255)', dataType: 'varchar', nullable: 'YES', key: '',
    defaultValue: null, extra: '', comment: '', ordinalPosition: 1,
  }
}

type CreateColOverrides = Partial<{
  name: string
  type: string
  size: string
  nullable: boolean
  primaryKey: boolean
  defaultValue: string
  comment: string
}>

function makeCreateCol(overrides: CreateColOverrides = {}) {
  return {
    name: 'col1', type: 'VARCHAR', size: '', nullable: true, primaryKey: false, defaultValue: '', comment: '', ...overrides,
  }
}

describe('generateAddColumnDDL', () => {
  it('produces ADD COLUMN with AFTER and comment', () => {
    const sql = generateAddColumnDDL('mydb', 'users', 'email', 'VARCHAR(255)', false, '', '用户邮箱', 'name')
    expect(sql).toMatch(/^ALTER TABLE `mydb`\.`users` ADD COLUMN `email`/)
    expect(sql).toContain('NOT NULL')
    expect(sql).toContain("COMMENT '用户邮箱'")
    expect(sql).toContain('AFTER `name`')
  })
  it('keeps numeric defaults unquoted and quotes strings', () => {
    expect(generateAddColumnDDL('mydb', 'users', 'age', 'INT', false, '0', '')).toContain('DEFAULT 0')
    expect(generateAddColumnDDL('mydb', 'users', 'age', 'INT', false, '0', '')).not.toContain("DEFAULT '0'")
    expect(generateAddColumnDDL('mydb', 'users', 's', 'VARCHAR(50)', false, 'active', '')).toContain("DEFAULT 'active'")
  })
})

describe('generateModifyColumnDDL / generateDropColumnDDL', () => {
  it('produces MODIFY COLUMN', () => {
    const sql = generateModifyColumnDDL('mydb', 'users', 'email', 'VARCHAR(500)', true, '', '更新邮箱')
    expect(sql).toMatch(/^ALTER TABLE `mydb`\.`users` MODIFY COLUMN `email`/)
    expect(sql).toContain('VARCHAR(500)')
    expect(sql).toContain('NULL')
  })
  it('produces DROP COLUMN', () => {
    expect(generateDropColumnDDL('mydb', 'users', 'old_col')).toBe('ALTER TABLE `mydb`.`users` DROP COLUMN `old_col`')
  })
})

describe('generateCreateIndexDDL / generateDropIndexDDL', () => {
  it('produces CREATE UNIQUE INDEX USING BTREE', () => {
    const sql = generateCreateIndexDDL('mydb', 'users', 'idx_email', ['email'], true, 'BTREE')
    expect(sql).toMatch(/^CREATE UNIQUE INDEX `idx_email`/)
    expect(sql).toContain('ON `mydb`.`users`')
    expect(sql).toContain('(`email`)')
    expect(sql).toContain('USING BTREE')
  })
  it('defaults to BTREE when indexType empty', () => {
    expect(generateCreateIndexDDL('mydb', 'users', 'i', ['name'], false, '')).toContain('USING BTREE')
    expect(generateCreateIndexDDL('mydb', 'users', 'i', ['a', 'b'], false, '')).not.toContain('UNIQUE')
  })
  it('produces DROP INDEX', () => {
    expect(generateDropIndexDDL('mydb', 'users', 'idx_email')).toMatch(/^DROP INDEX `idx_email`/)
    expect(generateDropIndexDDL('mydb', 'users', 'idx_email')).toContain('`mydb`.`users`')
  })
})

describe('generateBatchColumnDDL', () => {
  it('returns empty when no changes', () => {
    expect(generateBatchColumnDDL('mydb', 'users', [makeMeta('col1'), makeMeta('col2')], [makeCol(), makeCol({ name: 'col2', newName: 'col2' })])).toEqual([])
  })
  it('ADD COLUMN for a new column', () => {
    const [sql] = generateBatchColumnDDL('mydb', 'users', [makeMeta('col1')], [makeCol(), makeCol({ name: 'col2', newName: 'col2', newType: 'INT', newDefault: '0' })])
    expect(sql).toContain('ALTER TABLE `mydb`.`users`')
    expect(sql).toContain('ADD COLUMN `col2`')
    expect(sql).toContain('INT')
  })
  it('DROP COLUMN for dropped columns', () => {
    const [sql] = generateBatchColumnDDL('mydb', 'users', [makeMeta('col1'), makeMeta('col2')], [makeCol(), makeCol({ name: 'col2', newName: 'col2', dropped: true })])
    expect(sql).toContain('DROP COLUMN `col2`')
  })
  it('CHANGE COLUMN for renames and MODIFY for unrenamed changes', () => {
    const rename = generateBatchColumnDDL('mydb', 'users', [makeMeta('col1')], [makeCol({ name: 'col1', newName: 'renamed_col', dirty: true, newType: 'TEXT' })])
    expect(rename[0]).toContain('CHANGE COLUMN `col1` `renamed_col`')
    const modify = generateBatchColumnDDL('mydb', 'users', [makeMeta('col1')], [makeCol({ name: 'col1', newName: 'col1', dirty: true, newType: 'TEXT', newNullable: false })])
    expect(modify[0]).toContain('MODIFY COLUMN `col1`')
    expect(modify[0]).toContain('TEXT NOT NULL')
  })
  it('combines multiple ops comma-separated', () => {
    const [sql] = generateBatchColumnDDL(
      'mydb', 'users',
      [makeMeta('col1'), makeMeta('col2')],
      [makeCol({ name: 'col1', newName: 'col1', dirty: true, newType: 'TEXT' }), makeCol({ name: 'col2', newName: 'col2', dropped: true }), makeCol({ name: 'col3', newName: 'col3', newType: 'INT' })],
    )
    expect(sql).toContain('ADD COLUMN `col3`')
    expect(sql).toContain('DROP COLUMN `col2`')
    expect(sql).toContain('MODIFY COLUMN `col1`')
    expect(sql).toMatch(/,\n  /)
  })
})

describe('generateBatchIndexDDL', () => {
  it('drops and recreates dirty indexes', () => {
    const result = generateBatchIndexDDL('mydb', 'users', [{
      name: 'idx_old', newName: 'idx_new', columns: 'col1', newColumns: 'col1,col2',
      unique: false, newUnique: true, indexType: 'BTREE', newIndexType: 'BTREE', dirty: true, dropped: false, isNew: false,
    }])
    expect(result.length).toBe(2)
    expect(result[0]).toContain('DROP INDEX `idx_old`')
    expect(result[1]).toContain('CREATE UNIQUE INDEX `idx_new`')
    expect(result[1]).toContain('`col1`, `col2`')
  })
  it('only drops dropped indexes', () => {
    const result = generateBatchIndexDDL('mydb', 'users', [{
      name: 'idx_drop', newName: 'idx_drop', columns: 'col1', newColumns: 'col1',
      unique: false, newUnique: false, indexType: 'BTREE', newIndexType: 'BTREE', dirty: false, dropped: true, isNew: false,
    }])
    expect(result.length).toBe(1)
    expect(result[0]).toContain('DROP INDEX `idx_drop`')
  })
  it('does not DROP a brand-new index (Error 1091 regression)', () => {
    const result = generateBatchIndexDDL('mydb', 'users', [{
      name: 'gooids_idx', newName: 'gooids_idx', columns: 'gooids', newColumns: 'gooids',
      unique: false, newUnique: false, indexType: 'BTREE', newIndexType: 'BTREE', dirty: true, dropped: false, isNew: true,
    }])
    expect(result.length).toBe(1)
    expect(result[0]).toContain('CREATE INDEX `gooids_idx`')
    expect(result.some(d => d.includes('DROP INDEX'))).toBe(false)
  })
  it('emits nothing for a dropped brand-new index', () => {
    expect(generateBatchIndexDDL('mydb', 'users', [{
      name: 'idx_tmp', newName: 'idx_tmp', columns: 'col1', newColumns: 'col1',
      unique: false, newUnique: false, indexType: 'BTREE', newIndexType: 'BTREE', dirty: true, dropped: true, isNew: true,
    }])).toEqual([])
  })
})

describe('renderColumnType', () => {
  it('appends size, handles decimal scale, defaults VARCHAR/CHAR', () => {
    expect(renderColumnType('VARCHAR', '64')).toBe('VARCHAR(64)')
    expect(renderColumnType('DECIMAL', '10,2')).toBe('DECIMAL(10,2)')
    expect(renderColumnType('NUMERIC', ' 12 , 4 ')).toBe('NUMERIC(12,4)')
    expect(renderColumnType('VARCHAR', '')).toBe('VARCHAR(255)')
    expect(renderColumnType('CHAR', '')).toBe('CHAR(1)')
    expect(renderColumnType('DECIMAL', '')).toBe('DECIMAL')
  })
  it('keeps inline parentheses and rejects invalid size', () => {
    expect(renderColumnType('VARCHAR(100)', '')).toBe('VARCHAR(100)')
    expect(() => renderColumnType('VARCHAR', 'abc')).toThrow(/invalid column size/)
  })
})

describe('generateCreateTableDDL', () => {
  it('mysql: VARCHAR defaults to 255 and builds full DDL', () => {
    const [sql] = generateCreateTableDDL({
      dbType: 'mysql', database: 'mydb', table: 'images',
      columns: [
        makeCreateCol({ name: 'id', type: 'BIGINT', nullable: false, primaryKey: true }),
        makeCreateCol({ name: 'batch_no', type: 'VARCHAR', nullable: false, comment: '批次号' }),
      ],
      engine: 'InnoDB', charset: 'utf8mb4',
    })
    expect(sql).toMatch(/^CREATE TABLE `mydb`\.`images`/)
    expect(sql).toContain('`batch_no` VARCHAR(255) NOT NULL')
    expect(sql).toContain('PRIMARY KEY (`id`)')
    expect(sql).toContain('ENGINE=InnoDB')
    expect(sql).toContain('DEFAULT CHARSET=utf8mb4')
  })
  it('mysql: quotes string defaults, keeps function defaults', () => {
    const [sql] = generateCreateTableDDL({
      dbType: 'mysql', database: 'mydb', table: 't',
      columns: [
        makeCreateCol({ name: 'status', type: 'VARCHAR', defaultValue: 'active' }),
        makeCreateCol({ name: 'created_at', type: 'DATETIME', defaultValue: 'CURRENT_TIMESTAMP' }),
      ],
    })
    expect(sql).toContain("DEFAULT 'active'")
    expect(sql).toContain('DEFAULT CURRENT_TIMESTAMP')
    expect(sql).not.toContain("DEFAULT 'CURRENT_TIMESTAMP'")
  })
  it('postgresql: double quotes, separate COMMENT ON statements', () => {
    const stmts = generateCreateTableDDL({
      dbType: 'postgresql', database: 'public', table: 'users',
      columns: [
        makeCreateCol({ name: 'id', type: 'BIGINT', nullable: false, primaryKey: true }),
        makeCreateCol({ name: 'email', type: 'VARCHAR', size: '128', comment: '邮箱' }),
      ],
      tableComment: '用户表',
    })
    expect(stmts.length).toBe(3)
    expect(stmts[0]).toMatch(/^CREATE TABLE "public"\.\"users\"/)
    expect(stmts[0]).toContain('"email" VARCHAR(128) NULL')
    expect(stmts[0]).not.toContain('COMMENT')
    expect(stmts[1]).toBe('COMMENT ON COLUMN "public"."users"."email" IS \'邮箱\'')
    expect(stmts[2]).toBe('COMMENT ON TABLE "public"."users" IS \'用户表\'')
  })
  it('clickhouse: Nullable wrapper, MergeTree engine, ORDER BY pk', () => {
    const [sql] = generateCreateTableDDL({
      dbType: 'clickhouse', database: 'logs', table: 'events',
      columns: [
        makeCreateCol({ name: 'id', type: 'UInt64', nullable: false, primaryKey: true }),
        makeCreateCol({ name: 'msg', type: 'String', nullable: true, comment: '消息' }),
      ],
      engine: 'MergeTree',
    })
    expect(sql).toMatch(/^CREATE TABLE `logs`\.`events`/)
    expect(sql).toContain('`id` UInt64')
    expect(sql).toContain('`msg` Nullable(String)')
    expect(sql).not.toContain('NOT NULL')
    expect(sql).toContain('ENGINE = MergeTree()')
    expect(sql).toContain('ORDER BY (`id`)')
  })
  it('clickhouse: ORDER BY tuple() when no primary key', () => {
    const [sql] = generateCreateTableDDL({
      dbType: 'clickhouse', database: 'logs', table: 't', columns: [makeCreateCol({ name: 'msg', type: 'String' })],
    })
    expect(sql).toContain('ORDER BY tuple()')
  })
})
