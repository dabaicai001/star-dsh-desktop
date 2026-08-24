package adapters

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/rs/zerolog/log"
	_ "modernc.org/sqlite"
)

// SQLiteAdapter 封装 SQLite 连接
type SQLiteAdapter struct {
	db   *sqlx.DB
	conn *SQLiteConnInfo
}

// SQLiteConnInfo SQLite 连接参数
type SQLiteConnInfo struct {
	FilePath string `json:"filePath"`
}

// NewSQLiteAdapter 创建 SQLite 适配器
func NewSQLiteAdapter(info *SQLiteConnInfo) (*SQLiteAdapter, error) {
	if info.FilePath == "" {
		return nil, fmt.Errorf("sqlite file path is required")
	}

	db, err := sqlx.Connect("sqlite", info.FilePath)
	if err != nil {
		return nil, fmt.Errorf("sqlite connect failed: %w", err)
	}

	// SQLite 的并发模型不同于客户端/服务器数据库，限制连接数避免锁冲突
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0) // 不主动回收

	// 启用 WAL 模式和忙等待超时
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("sqlite set WAL mode: %w", err)
	}
	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("sqlite set busy_timeout: %w", err)
	}

	log.Info().Str("filePath", info.FilePath).Msg("sqlite connected")

	return &SQLiteAdapter{db: db, conn: info}, nil
}

// Close 关闭连接
func (a *SQLiteAdapter) Close() error {
	return a.db.Close()
}

// Ping 检测连接
func (a *SQLiteAdapter) Ping() error {
	return a.db.Ping()
}

// DefaultNamespace 返回默认数据库命名空间
func (a *SQLiteAdapter) DefaultNamespace() string { return "main" }

// ScopeSQL SQLite 不支持 USE database，直接返回原始 SQL
func (a *SQLiteAdapter) ScopeSQL(sqlText, namespace string) string {
	return sqlText
}

// quoteSQLiteIdentifier 用双引号引用 SQLite 标识符
func quoteSQLiteIdentifier(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}

// ListDatabases SQLite 只有一个 "main" 数据库
func (a *SQLiteAdapter) ListDatabases() ([]string, error) {
	return []string{"main"}, nil
}

// ListTables 列出所有表
func (a *SQLiteAdapter) ListTables(_ string) ([]TableInfo, error) {
	var tables []TableInfo
	err := a.db.Select(&tables, `SELECT name, type AS type, '' AS engine, 0 AS rows, '' AS comment
		FROM sqlite_master
		WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
		ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list sqlite tables: %w", err)
	}
	return tables, nil
}

// ListColumns 列出表的所有列
func (a *SQLiteAdapter) ListColumns(_, table string) ([]ColumnMeta, error) {
	// SQLite PRAGMA 不支持参数绑定，需要安全引用表名
	rows, err := a.db.Queryx(fmt.Sprintf("PRAGMA table_info(%s)", quoteSQLiteIdentifier(table)))
	if err != nil {
		return nil, fmt.Errorf("list sqlite columns: %w", err)
	}
	defer rows.Close()

	var columns []ColumnMeta
	for rows.Next() {
		var cid int
		var name, dataType string
		var notNull int
		var dfltValue *string
		var pk int
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &dfltValue, &pk); err != nil {
			return nil, fmt.Errorf("scan sqlite column: %w", err)
		}
		nullable := "YES"
		if notNull == 1 {
			nullable = "NO"
		}
		key := ""
		if pk > 0 {
			key = "PRI"
		}
		columns = append(columns, ColumnMeta{
			Name:         name,
			Type:         dataType,
			DataType:     dataType,
			Nullable:     nullable,
			Key:          key,
			DefaultValue: dfltValue,
			Extra:        "",
			Comment:      "",
			OrdinalPos:   cid + 1,
		})
	}
	return columns, nil
}

// ListIndexes 列出表的索引
func (a *SQLiteAdapter) ListIndexes(_, table string) ([]IndexInfo, error) {
	// 先获取索引列表
	indexRows, err := a.db.Queryx(fmt.Sprintf("PRAGMA index_list(%s)", quoteSQLiteIdentifier(table)))
	if err != nil {
		return nil, fmt.Errorf("list sqlite indexes: %w", err)
	}
	defer indexRows.Close()

	type indexListItem struct {
		Seq     int
		Name    string
		Unique  int
		Origin  string
		Partial int
	}

	var indexList []indexListItem
	for indexRows.Next() {
		var item indexListItem
		if err := indexRows.StructScan(&item); err != nil {
			return nil, fmt.Errorf("scan sqlite index list: %w", err)
		}
		indexList = append(indexList, item)
	}

	var indexes []IndexInfo
	for _, idx := range indexList {
		// 获取每个索引的列信息
		colRows, err := a.db.Queryx(fmt.Sprintf("PRAGMA index_info(%s)", quoteSQLiteIdentifier(idx.Name)))
		if err != nil {
			return nil, fmt.Errorf("get sqlite index info: %w", err)
		}

		seqInIndex := 1
		for colRows.Next() {
			var seqno, cid int
			var colName string
			if err := colRows.Scan(&seqno, &cid, &colName); err != nil {
				colRows.Close()
				return nil, fmt.Errorf("scan sqlite index col: %w", err)
			}
			nonUnique := 1
			if idx.Unique == 1 {
				nonUnique = 0
			}
			indexes = append(indexes, IndexInfo{
				TableName:  table,
				NonUnique:  nonUnique,
				KeyName:    idx.Name,
				SeqInIndex: seqInIndex,
				ColumnName: colName,
				IndexType:  "BTREE",
				Visible:    "YES",
			})
			seqInIndex++
		}
		colRows.Close()
	}
	return indexes, nil
}

// CreateIndex 创建索引
func (a *SQLiteAdapter) CreateIndex(_, table, indexName string, columns []string, unique bool, _ string) error {
	cols := make([]string, len(columns))
	for i, c := range columns {
		cols[i] = quoteSQLiteIdentifier(c)
	}
	uniqueStr := ""
	if unique {
		uniqueStr = "UNIQUE "
	}
	query := fmt.Sprintf("CREATE %sINDEX %s ON %s (%s)",
		uniqueStr, quoteSQLiteIdentifier(indexName), quoteSQLiteIdentifier(table), strings.Join(cols, ", "))
	_, err := a.db.Exec(query)
	if err != nil {
		return fmt.Errorf("create sqlite index: %w", err)
	}
	return nil
}

// DropIndex 删除索引
func (a *SQLiteAdapter) DropIndex(_, _, indexName string) error {
	_, err := a.db.Exec("DROP INDEX " + quoteSQLiteIdentifier(indexName))
	if err != nil {
		return fmt.Errorf("drop sqlite index: %w", err)
	}
	return nil
}

// Execute 执行 SQL
func (a *SQLiteAdapter) Execute(sqlStr string) (*QueryResult, error) {
	start := time.Now()
	sqlStr = strings.TrimSpace(sqlStr)
	if sqlStr == "" {
		return &QueryResult{Error: "empty SQL"}, nil
	}

	upper := strings.ToUpper(sqlStr)
	isSelect := strings.HasPrefix(upper, "SELECT") ||
		strings.HasPrefix(upper, "WITH") ||
		strings.HasPrefix(upper, "PRAGMA") ||
		strings.HasPrefix(upper, "EXPLAIN") ||
		strings.HasPrefix(upper, "VALUES")

	if isSelect {
		if !limitRegex.MatchString(sqlStr) && !strings.HasPrefix(upper, "PRAGMA") {
			sqlStr = sqlStr + " LIMIT 100"
		}
		return a.executeSelect(sqlStr, nil, start)
	}
	return a.executeExec(sqlStr, start)
}

func (a *SQLiteAdapter) executeSelect(query string, args []interface{}, start time.Time) (*QueryResult, error) {
	rows, err := a.db.Queryx(query, args...)
	if err != nil {
		return &QueryResult{DurationMs: time.Since(start).Milliseconds(), Error: err.Error(), IsSelect: true}, nil
	}
	defer rows.Close()

	columnTypes, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	columns := make([]ColumnInfo, len(columnTypes))
	for i, ct := range columnTypes {
		columns[i] = ColumnInfo{Name: ct.Name(), Type: ct.DatabaseTypeName()}
	}

	var data [][]interface{}
	for rows.Next() {
		values, err := rows.SliceScan()
		if err != nil {
			return nil, err
		}
		for i, v := range values {
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			}
		}
		data = append(data, values)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &QueryResult{
		Columns:    columns,
		Rows:       data,
		IsSelect:   true,
		DurationMs: time.Since(start).Milliseconds(),
	}, nil
}

func (a *SQLiteAdapter) executeExec(sqlStr string, start time.Time) (*QueryResult, error) {
	result, err := a.db.Exec(sqlStr)
	if err != nil {
		return &QueryResult{DurationMs: time.Since(start).Milliseconds(), Error: err.Error()}, nil
	}
	affected, _ := result.RowsAffected()
	lastID, _ := result.LastInsertId()
	return &QueryResult{
		RowsAffected: affected,
		LastInsertID: lastID,
		DurationMs:   time.Since(start).Milliseconds(),
	}, nil
}

// Explain 获取执行计划
func (a *SQLiteAdapter) Explain(sqlStr string) (*QueryResult, error) {
	return a.executeSelect("EXPLAIN QUERY PLAN "+sqlStr, nil, time.Now())
}

// GetTableDDL 获取建表 DDL
func (a *SQLiteAdapter) GetTableDDL(_, table string) (string, error) {
	var ddl string
	err := a.db.Get(&ddl, "SELECT sql FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?", table)
	if err != nil {
		return "", fmt.Errorf("get sqlite ddl: %w", err)
	}
	return ddl, nil
}

// GetTableData 分页获取表数据
func (a *SQLiteAdapter) GetTableData(_, table string, limit, offset int, orderBy, orderDir, filter, quickFilter string, columnFilters map[string]string) (*QueryResult, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 10000 {
		limit = 10000
	}

	query := "SELECT * FROM " + quoteSQLiteIdentifier(table)

	var conditions []string
	var args []interface{}

	if filter != "" {
		conditions = append(conditions, "("+filter+")")
	}

	if len(columnFilters) > 0 {
		for col, val := range columnFilters {
			conditions = append(conditions, fmt.Sprintf("%s = ?", quoteSQLiteIdentifier(col)))
			args = append(args, val)
		}
	}

	// 快捷筛选:所有列 LIKE '%kw%'(列名来自 PRAGMA table_info,参数化防注入)
	if quickFilter != "" {
		cols, err := a.ListColumns("", table)
		if err != nil {
			return nil, fmt.Errorf("quick filter: %w", err)
		}
		var likeParts []string
		for _, c := range cols {
			if c.Name == "" {
				continue
			}
			likeParts = append(likeParts, fmt.Sprintf("CAST(%s AS TEXT) LIKE ?", quoteSQLiteIdentifier(c.Name)))
			args = append(args, "%"+quickFilter+"%")
		}
		if len(likeParts) > 0 {
			conditions = append(conditions, "("+strings.Join(likeParts, " OR ")+")")
		}
	}

	whereClause := ""
	if len(conditions) > 0 {
		whereClause = " WHERE " + strings.Join(conditions, " AND ")
		query += whereClause
	}

	if orderBy != "" {
		dir := "ASC"
		if strings.ToUpper(orderDir) == "DESC" {
			dir = "DESC"
		}
		query += fmt.Sprintf(" ORDER BY %s %s", quoteSQLiteIdentifier(orderBy), dir)
	}
	query += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)

	result, err := a.executeSelect(query, args, time.Now())
	if err != nil {
		return nil, fmt.Errorf("get sqlite table data: %w", err)
	}

	if whereClause != "" && result.Error == "" {
		countQuery := "SELECT COUNT(*) FROM " + quoteSQLiteIdentifier(table) + whereClause
		var totalRows int64
		if len(args) > 0 {
			if err := a.db.Get(&totalRows, countQuery, args...); err == nil {
				result.TotalRows = totalRows
			}
		} else {
			if err := a.db.Get(&totalRows, countQuery); err == nil {
				result.TotalRows = totalRows
			}
		}
	}

	return result, nil
}

// GetRowCount 获取表行数
func (a *SQLiteAdapter) GetRowCount(_, table string) (int64, error) {
	var count int64
	err := a.db.Get(&count, "SELECT COUNT(*) FROM "+quoteSQLiteIdentifier(table))
	return count, err
}

// GetTableMeta 批量获取表元信息
func (a *SQLiteAdapter) GetTableMeta(database, table string) (*TableMeta, error) {
	var (
		columns  []ColumnMeta
		rowCount int64
		colsErr  error
		cntErr   error
		wg       sync.WaitGroup
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		columns, colsErr = a.ListColumns(database, table)
	}()
	go func() {
		defer wg.Done()
		rowCount, cntErr = a.GetRowCount(database, table)
	}()
	wg.Wait()

	if colsErr != nil {
		return nil, fmt.Errorf("list columns: %w", colsErr)
	}
	if cntErr != nil {
		return nil, fmt.Errorf("get row count: %w", cntErr)
	}
	return &TableMeta{Columns: columns, RowCount: rowCount}, nil
}

// DropTable 删除表
func (a *SQLiteAdapter) DropTable(_, table string, ifExists bool) error {
	stmt := "DROP TABLE"
	if ifExists {
		stmt += " IF EXISTS"
	}
	stmt += " " + quoteSQLiteIdentifier(table)
	_, err := a.db.Exec(stmt)
	return err
}

// TruncateTable 清空表（SQLite 不支持 TRUNCATE，使用 DELETE）
func (a *SQLiteAdapter) TruncateTable(_, table string) error {
	_, err := a.db.Exec("DELETE FROM " + quoteSQLiteIdentifier(table))
	return err
}

// RenameTable 重命名表
func (a *SQLiteAdapter) RenameTable(_, oldName, newName string) error {
	_, err := a.db.Exec("ALTER TABLE " + quoteSQLiteIdentifier(oldName) + " RENAME TO " + quoteSQLiteIdentifier(newName))
	return err
}

// InsertRow 插入一行
func (a *SQLiteAdapter) InsertRow(_, table string, values map[string]interface{}) (int64, error) {
	cols := make([]string, 0, len(values))
	placeholders := make([]string, 0, len(values))
	args := make([]interface{}, 0, len(values))
	for col, val := range values {
		cols = append(cols, quoteSQLiteIdentifier(col))
		placeholders = append(placeholders, "?")
		args = append(args, val)
	}
	query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
		quoteSQLiteIdentifier(table), strings.Join(cols, ", "), strings.Join(placeholders, ", "))
	result, err := a.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// UpdateRows 批量更新行
func (a *SQLiteAdapter) UpdateRows(_, table string, sets map[string]interface{}, where string) (int64, error) {
	setParts := make([]string, 0, len(sets))
	args := make([]interface{}, 0, len(sets))
	for col, val := range sets {
		setParts = append(setParts, fmt.Sprintf("%s = ?", quoteSQLiteIdentifier(col)))
		args = append(args, val)
	}
	query := fmt.Sprintf("UPDATE %s SET %s", quoteSQLiteIdentifier(table), strings.Join(setParts, ", "))
	if where != "" {
		query += " WHERE " + where
	}
	result, err := a.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// DeleteRows 删除行
func (a *SQLiteAdapter) DeleteRows(_, table, where string) (int64, error) {
	query := "DELETE FROM " + quoteSQLiteIdentifier(table)
	if where != "" {
		query += " WHERE " + where
	}
	result, err := a.db.Exec(query)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// ExportCSV 导出表为 CSV
func (a *SQLiteAdapter) ExportCSV(_, table string, limit int) (*QueryResult, error) {
	if limit <= 0 {
		limit = 100000
	}
	query := fmt.Sprintf("SELECT * FROM %s LIMIT %d", quoteSQLiteIdentifier(table), limit)
	return a.executeSelect(query, nil, time.Now())
}

// ExportJSON 导出表为 JSON
func (a *SQLiteAdapter) ExportJSON(_, table string, limit int) (string, error) {
	result, err := a.ExportCSV("", table, limit)
	if err != nil {
		return "", err
	}
	type Row map[string]interface{}
	rows := make([]Row, len(result.Rows))
	for i, row := range result.Rows {
		r := make(Row, len(result.Columns))
		for j, col := range result.Columns {
			if j < len(row) {
				r[col.Name] = row[j]
			}
		}
		rows[i] = r
	}
	data, err := json.MarshalIndent(rows, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}
