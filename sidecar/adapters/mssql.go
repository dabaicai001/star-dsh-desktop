package adapters

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jmoiron/sqlx"
	_ "github.com/microsoft/go-mssqldb"
	"github.com/rs/zerolog/log"
)

// MSSQLAdapter 封装 SQL Server 连接
type MSSQLAdapter struct {
	db   *sqlx.DB
	conn *MSSQLConnInfo
}

// MSSQLConnInfo SQL Server 连接参数
type MSSQLConnInfo struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	Database string `json:"database,omitempty"`
	SSL      bool   `json:"ssl,omitempty"`
}

// NewMSSQLAdapter 创建 SQL Server 适配器
func NewMSSQLAdapter(info *MSSQLConnInfo) (*MSSQLAdapter, error) {
	if info.Port == 0 {
		info.Port = 1433
	}

	// 构建 SQL Server 连接 URL
	u := &url.URL{
		Scheme: "sqlserver",
		User:   url.UserPassword(info.Username, info.Password),
		Host:   fmt.Sprintf("%s:%d", info.Host, info.Port),
	}
	if info.Database != "" {
		u.Path = info.Database
	}
	query := u.Query()
	if info.SSL {
		query.Set("encrypt", "true")
		query.Set("trustServerCertificate", "false")
	} else {
		query.Set("encrypt", "false")
	}
	query.Set("connection timeout", "10")
	u.RawQuery = query.Encode()

	db, err := sqlx.Connect("sqlserver", u.String())
	if err != nil {
		return nil, fmt.Errorf("mssql connect failed: %w", err)
	}

	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)

	log.Info().Str("host", info.Host).Int("port", info.Port).Str("db", info.Database).Msg("mssql connected")

	return &MSSQLAdapter{db: db, conn: info}, nil
}

// Close 关闭连接
func (a *MSSQLAdapter) Close() error {
	return a.db.Close()
}

// Ping 检测连接
func (a *MSSQLAdapter) Ping() error {
	return a.db.Ping()
}

// DefaultNamespace 返回默认命名空间（空字符串，MSSQL 使用默认 schema dbo）
func (a *MSSQLAdapter) DefaultNamespace() string { return "" }

// ScopeSQL SQL Server 不需要 USE 前缀（表引用使用 schema.table 限定）
func (a *MSSQLAdapter) ScopeSQL(sqlText, namespace string) string {
	return sqlText
}

// quoteMSSQLIdentifier 用方括号引用 SQL Server 标识符
func quoteMSSQLIdentifier(identifier string) string {
	return "[" + strings.ReplaceAll(identifier, "]", "]]") + "]"
}

func mssqlSchema(schema string) string {
	if schema == "" {
		return "dbo"
	}
	return schema
}

func qualifiedMSSQLIdentifier(schema, table string) string {
	return quoteMSSQLIdentifier(mssqlSchema(schema)) + "." + quoteMSSQLIdentifier(table)
}

// ListDatabases 列出所有数据库
func (a *MSSQLAdapter) ListDatabases() ([]string, error) {
	var dbs []string
	err := a.db.Select(&dbs, "SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name")
	if err != nil {
		return nil, fmt.Errorf("list mssql databases: %w", err)
	}
	return dbs, nil
}

// ListTables 列出 schema 下的所有表
func (a *MSSQLAdapter) ListTables(schema string) ([]TableInfo, error) {
	var tables []TableInfo
	err := a.db.Select(&tables, `SELECT TABLE_NAME AS name, TABLE_TYPE AS type,
		'' AS engine, 0 AS rows, '' AS comment
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = ?
		ORDER BY TABLE_NAME`, mssqlSchema(schema))
	if err != nil {
		return nil, fmt.Errorf("list mssql tables: %w", err)
	}
	return tables, nil
}

// ListColumns 列出表的所有列
func (a *MSSQLAdapter) ListColumns(schema, table string) ([]ColumnMeta, error) {
	var columns []ColumnMeta
	err := a.db.Select(&columns, `SELECT
		COLUMN_NAME AS "COLUMN_NAME",
		DATA_TYPE AS "COLUMN_TYPE",
		DATA_TYPE AS "DATA_TYPE",
		IS_NULLABLE AS "IS_NULLABLE",
		CASE WHEN COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)), COLUMN_NAME, 'IsIdentity') = 1 THEN 'auto_increment'
		     ELSE '' END AS "COLUMN_KEY",
		COLUMN_DEFAULT AS "COLUMN_DEFAULT",
		'' AS "EXTRA",
		'' AS "COLUMN_COMMENT",
		ORDINAL_POSITION AS "ORDINAL_POSITION"
		FROM INFORMATION_SCHEMA.COLUMNS
		WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
		ORDER BY ORDINAL_POSITION`, mssqlSchema(schema), table)
	if err != nil {
		return nil, fmt.Errorf("list mssql columns: %w", err)
	}
	return columns, nil
}

// ListIndexes 列出表的索引
func (a *MSSQLAdapter) ListIndexes(schema, table string) ([]IndexInfo, error) {
	var indexes []IndexInfo
	err := a.db.Select(&indexes, `SELECT
		t.name AS "Table",
		CASE WHEN i.is_unique = 1 THEN 0 ELSE 1 END AS "Non_unique",
		i.name AS "Key_name",
		ic.key_ordinal AS "Seq_in_index",
		c.name AS "Column_name",
		'A' AS "Collation",
		CAST(NULL AS bigint) AS "Cardinality",
		CAST(NULL AS bigint) AS "Sub_part",
		CAST(NULL AS nvarchar(1)) AS "Packed",
		'' AS "Null",
		i.type_desc AS "Index_type",
		'' AS "Comment",
		'' AS "Index_comment",
		'YES' AS "Visible",
		CAST(NULL AS nvarchar(1)) AS "Expression"
		FROM sys.indexes i
		INNER JOIN sys.tables t ON t.object_id = i.object_id
		INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
		INNER JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
		INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
		WHERE s.name = ? AND t.name = ?
		ORDER BY i.name, ic.key_ordinal`, mssqlSchema(schema), table)
	if err != nil {
		return nil, fmt.Errorf("list mssql indexes: %w", err)
	}
	return indexes, nil
}

// CreateIndex 创建索引
func (a *MSSQLAdapter) CreateIndex(schema, table, indexName string, columns []string, unique bool, _ string) error {
	cols := make([]string, len(columns))
	for i, c := range columns {
		cols[i] = quoteMSSQLIdentifier(c)
	}
	uniqueStr := ""
	if unique {
		uniqueStr = "UNIQUE "
	}
	query := fmt.Sprintf("CREATE %sINDEX %s ON %s (%s)",
		uniqueStr, quoteMSSQLIdentifier(indexName), qualifiedMSSQLIdentifier(schema, table), strings.Join(cols, ", "))
	_, err := a.db.Exec(query)
	if err != nil {
		return fmt.Errorf("create mssql index: %w", err)
	}
	return nil
}

// DropIndex 删除索引
func (a *MSSQLAdapter) DropIndex(schema, table, indexName string) error {
	query := fmt.Sprintf("DROP INDEX %s ON %s", quoteMSSQLIdentifier(indexName), qualifiedMSSQLIdentifier(schema, table))
	_, err := a.db.Exec(query)
	if err != nil {
		return fmt.Errorf("drop mssql index: %w", err)
	}
	return nil
}

// Execute 执行 SQL
func (a *MSSQLAdapter) Execute(sqlStr string) (*QueryResult, error) {
	start := time.Now()
	sqlStr = strings.TrimSpace(sqlStr)
	if sqlStr == "" {
		return &QueryResult{Error: "empty SQL"}, nil
	}

	upper := strings.ToUpper(sqlStr)
	isSelect := strings.HasPrefix(upper, "SELECT") ||
		strings.HasPrefix(upper, "WITH") ||
		strings.HasPrefix(upper, "VALUES") ||
		strings.HasPrefix(upper, "EXPLAIN") ||
		strings.HasPrefix(upper, "EXEC") ||
		strings.HasPrefix(upper, "SP_") ||
		strings.HasPrefix(upper, "SHOW")

	if isSelect {
		if !limitRegex.MatchString(sqlStr) {
			// 使用 TOP 100 而非 LIMIT（SQL Server 使用 TOP）
			sqlStr = strings.Replace(sqlStr, "SELECT", "SELECT TOP 100", 1)
		}
		return a.executeSelect(sqlStr, nil, start)
	}
	return a.executeExec(sqlStr, start)
}

func (a *MSSQLAdapter) executeSelect(query string, args []interface{}, start time.Time) (*QueryResult, error) {
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
		nullable, _ := ct.Nullable()
		columns[i] = ColumnInfo{Name: ct.Name(), Type: ct.DatabaseTypeName(), Nullable: nullable}
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

func (a *MSSQLAdapter) executeExec(sqlStr string, start time.Time) (*QueryResult, error) {
	result, err := a.db.Exec(sqlStr)
	if err != nil {
		return &QueryResult{DurationMs: time.Since(start).Milliseconds(), Error: err.Error()}, nil
	}
	affected, _ := result.RowsAffected()
	return &QueryResult{
		RowsAffected: affected,
		DurationMs:   time.Since(start).Milliseconds(),
	}, nil
}

// Explain 获取执行计划
func (a *MSSQLAdapter) Explain(sqlStr string) (*QueryResult, error) {
	// SQL Server 使用 SET SHOWPLAN_TEXT ON 获取执行计划
	_, _ = a.db.Exec("SET SHOWPLAN_TEXT ON")
	defer func() { _, _ = a.db.Exec("SET SHOWPLAN_TEXT OFF") }()
	return a.executeSelect(sqlStr, nil, time.Now())
}

// GetTableDDL 获取建表 DDL
func (a *MSSQLAdapter) GetTableDDL(schema, table string) (string, error) {
	columns, err := a.ListColumns(schema, table)
	if err != nil {
		return "", err
	}
	definitions := make([]string, 0, len(columns))
	for _, col := range columns {
		def := "  " + quoteMSSQLIdentifier(col.Name) + " " + col.Type
		if col.Nullable == "NO" {
			def += " NOT NULL"
		}
		if col.DefaultValue != nil && *col.DefaultValue != "" {
			def += " DEFAULT " + *col.DefaultValue
		}
		if col.Key == "auto_increment" {
			def += " IDENTITY(1,1)"
		}
		definitions = append(definitions, def)
	}
	return fmt.Sprintf("CREATE TABLE %s (\n%s\n);",
		qualifiedMSSQLIdentifier(schema, table),
		strings.Join(definitions, ",\n")), nil
}

// GetTableData 分页获取表数据
func (a *MSSQLAdapter) GetTableData(schema, table string, limit, offset int, orderBy, orderDir, filter, quickFilter string, columnFilters map[string]string) (*QueryResult, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 10000 {
		limit = 10000
	}

	// SQL Server 使用 OFFSET ... FETCH 分页（2012+）
	query := "SELECT * FROM " + qualifiedMSSQLIdentifier(schema, table)

	var conditions []string
	var args []interface{}

	if filter != "" {
		conditions = append(conditions, "("+filter+")")
	}

	if len(columnFilters) > 0 {
		keys := make([]string, 0, len(columnFilters))
		for col := range columnFilters {
			keys = append(keys, col)
		}
		sort.Strings(keys)
		for _, col := range keys {
			conditions = append(conditions, fmt.Sprintf("%s = ?", quoteMSSQLIdentifier(col)))
			args = append(args, columnFilters[col])
		}
	}

	// 快捷筛选:所有列 LIKE '%kw%'(列名来自 INFORMATION_SCHEMA,参数化防注入)
	if quickFilter != "" {
		cols, err := a.ListColumns(schema, table)
		if err != nil {
			return nil, fmt.Errorf("quick filter: %w", err)
		}
		var likeParts []string
		for _, c := range cols {
			if c.Name == "" {
				continue
			}
			likeParts = append(likeParts, fmt.Sprintf("CAST(%s AS NVARCHAR(MAX)) LIKE ?", quoteMSSQLIdentifier(c.Name)))
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
		query += fmt.Sprintf(" ORDER BY %s %s", quoteMSSQLIdentifier(orderBy), dir)
		query += fmt.Sprintf(" OFFSET %d ROWS FETCH NEXT %d ROWS ONLY", offset, limit)
	} else {
		// OFFSET/FETCH 要求 ORDER BY 子句，使用任意排序列
		query += " ORDER BY (SELECT NULL)"
		query += fmt.Sprintf(" OFFSET %d ROWS FETCH NEXT %d ROWS ONLY", offset, limit)
	}

	result, err := a.executeSelect(query, args, time.Now())
	if err != nil {
		return nil, fmt.Errorf("get mssql table data: %w", err)
	}

	if whereClause != "" && result.Error == "" {
		countQuery := "SELECT COUNT(*) FROM " + qualifiedMSSQLIdentifier(schema, table) + whereClause
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
func (a *MSSQLAdapter) GetRowCount(schema, table string) (int64, error) {
	var count int64
	err := a.db.Get(&count, "SELECT COUNT(*) FROM "+qualifiedMSSQLIdentifier(schema, table))
	return count, err
}

// GetTableMeta 批量获取表元信息
func (a *MSSQLAdapter) GetTableMeta(schema, table string) (*TableMeta, error) {
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
		columns, colsErr = a.ListColumns(schema, table)
	}()
	go func() {
		defer wg.Done()
		rowCount, cntErr = a.GetRowCount(schema, table)
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
func (a *MSSQLAdapter) DropTable(schema, table string, ifExists bool) error {
	stmt := "DROP TABLE"
	if ifExists {
		stmt += " IF EXISTS"
	}
	stmt += " " + qualifiedMSSQLIdentifier(schema, table)
	_, err := a.db.Exec(stmt)
	return err
}

// TruncateTable 清空表
func (a *MSSQLAdapter) TruncateTable(schema, table string) error {
	_, err := a.db.Exec("TRUNCATE TABLE " + qualifiedMSSQLIdentifier(schema, table))
	return err
}

// RenameTable 重命名表
func (a *MSSQLAdapter) RenameTable(schema, oldName, newName string) error {
	_, err := a.db.Exec("sp_rename '" + qualifiedMSSQLIdentifier(schema, oldName) + "', '" + newName + "'")
	return err
}

// InsertRow 插入一行
func (a *MSSQLAdapter) InsertRow(schema, table string, values map[string]interface{}) (int64, error) {
	cols := make([]string, 0, len(values))
	placeholders := make([]string, 0, len(values))
	args := make([]interface{}, 0, len(values))
	for col, val := range values {
		cols = append(cols, quoteMSSQLIdentifier(col))
		placeholders = append(placeholders, "?")
		args = append(args, val)
	}
	query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
		qualifiedMSSQLIdentifier(schema, table), strings.Join(cols, ", "), strings.Join(placeholders, ", "))
	result, err := a.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// UpdateRows 批量更新行
func (a *MSSQLAdapter) UpdateRows(schema, table string, sets map[string]interface{}, where string) (int64, error) {
	setParts := make([]string, 0, len(sets))
	args := make([]interface{}, 0, len(sets))
	for col, val := range sets {
		setParts = append(setParts, fmt.Sprintf("%s = ?", quoteMSSQLIdentifier(col)))
		args = append(args, val)
	}
	query := fmt.Sprintf("UPDATE %s SET %s", qualifiedMSSQLIdentifier(schema, table), strings.Join(setParts, ", "))
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
func (a *MSSQLAdapter) DeleteRows(schema, table, where string) (int64, error) {
	query := "DELETE FROM " + qualifiedMSSQLIdentifier(schema, table)
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
func (a *MSSQLAdapter) ExportCSV(schema, table string, limit int) (*QueryResult, error) {
	if limit <= 0 {
		limit = 100000
	}
	query := fmt.Sprintf("SELECT TOP %d * FROM %s", limit, qualifiedMSSQLIdentifier(schema, table))
	return a.executeSelect(query, nil, time.Now())
}

// ExportJSON 导出表为 JSON
func (a *MSSQLAdapter) ExportJSON(schema, table string, limit int) (string, error) {
	result, err := a.ExportCSV(schema, table, limit)
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
