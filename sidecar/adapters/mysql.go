package adapters

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jmoiron/sqlx"
	"github.com/rs/zerolog/log"
	"github.com/xuri/excelize/v2"
)

// limitRegex 用于检测 SQL 中是否已包含 LIMIT 子句,避免重复编译。
var limitRegex = regexp.MustCompile(`(?i)\bLIMIT\s+\d+`)

// MySQLAdapter 封装 MySQL 连接
type MySQLAdapter struct {
	db   *sqlx.DB
	conn *MySQLConnInfo
}

// MySQLConnInfo MySQL 连接参数
type MySQLConnInfo struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	Database string `json:"database,omitempty"`
	SSL      bool   `json:"ssl,omitempty"`
}

// QueryResult 查询结果
type QueryResult struct {
	Columns      []ColumnInfo    `json:"columns"`
	Rows         [][]interface{} `json:"rows"`
	RowsAffected int64           `json:"rowsAffected"`
	LastInsertID int64           `json:"lastInsertId,omitempty"`
	DurationMs   int64           `json:"durationMs"`
	IsSelect     bool            `json:"isSelect"`
	Error        string          `json:"error,omitempty"`
	TotalRows    int64           `json:"totalRows,omitempty"`
}

// ColumnInfo 列信息
type ColumnInfo struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
}

// TableInfo 表信息
type TableInfo struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Engine  string `json:"engine,omitempty"`
	Rows    int64  `json:"rows,omitempty"`
	Comment string `json:"comment,omitempty"`
}

// ColumnMeta 列元数据
type ColumnMeta struct {
	Name         string  `json:"name" db:"COLUMN_NAME"`
	Type         string  `json:"type" db:"COLUMN_TYPE"`
	DataType     string  `json:"dataType" db:"DATA_TYPE"`
	Nullable     string  `json:"nullable" db:"IS_NULLABLE"`
	Key          string  `json:"key" db:"COLUMN_KEY"`
	DefaultValue *string `json:"defaultValue" db:"COLUMN_DEFAULT"`
	Extra        string  `json:"extra" db:"EXTRA"`
	Comment      string  `json:"comment" db:"COLUMN_COMMENT"`
	OrdinalPos   int     `json:"ordinalPosition" db:"ORDINAL_POSITION"`
}

// IndexInfo 索引信息
type IndexInfo struct {
	TableName    string  `json:"tableName" db:"Table"`
	NonUnique    int     `json:"nonUnique" db:"Non_unique"`
	KeyName      string  `json:"keyName" db:"Key_name"`
	SeqInIndex   int     `json:"seqInIndex" db:"Seq_in_index"`
	ColumnName   string  `json:"columnName" db:"Column_name"`
	Collation    string  `json:"collation" db:"Collation"`
	Cardinality  *int64  `json:"cardinality" db:"Cardinality"`
	SubPart      *int64  `json:"subPart" db:"Sub_part"`
	Packed       *string `json:"packed" db:"Packed"`
	Null         string  `json:"null" db:"Null"`
	IndexType    string  `json:"indexType" db:"Index_type"`
	Comment      string  `json:"comment" db:"Comment"`
	IndexComment string  `json:"indexComment" db:"Index_comment"`
	Visible      string  `json:"visible" db:"Visible"`
	Expression   *string `json:"expression" db:"Expression"`
}

// TableMeta 表元信息（列 + 行数，一次请求并行获取）
type TableMeta struct {
	Columns  []ColumnMeta `json:"columns"`
	RowCount int64        `json:"rowCount"`
}

const mysqlListTablesQuery = `SELECT TABLE_NAME as name, TABLE_TYPE as type,
		COALESCE(ENGINE, '') as engine,
		COALESCE(TABLE_ROWS, 0) as rows,
		COALESCE(TABLE_COMMENT, '') as comment
		FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`

// NewMySQLAdapter 创建 MySQL 适配器
func NewMySQLAdapter(info *MySQLConnInfo) (*MySQLAdapter, error) {
	if info.Port == 0 {
		info.Port = 3306
	}

	cfg := mysql.Config{
		User:                 info.Username,
		Passwd:               info.Password,
		Net:                  "tcp",
		Addr:                 fmt.Sprintf("%s:%d", info.Host, info.Port),
		DBName:               info.Database,
		AllowNativePasswords: true,
		MultiStatements:      true,
		ParseTime:            true,
		Timeout:              10 * time.Second,
		ReadTimeout:          30 * time.Second,
		WriteTimeout:         30 * time.Second,
		Loc:                  time.UTC,
	}

	if info.SSL {
		cfg.TLSConfig = "true"
	}

	db, err := sqlx.Connect("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, fmt.Errorf("mysql connect failed: %w", err)
	}

	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)

	log.Info().Str("host", info.Host).Int("port", info.Port).Str("db", info.Database).Msg("mysql connected")

	return &MySQLAdapter{db: db, conn: info}, nil
}

// Close 关闭连接
func (a *MySQLAdapter) Close() error {
	return a.db.Close()
}

// Ping 检测连接
func (a *MySQLAdapter) Ping() error {
	return a.db.Ping()
}

func (a *MySQLAdapter) DefaultNamespace() string { return a.conn.Database }
func (a *MySQLAdapter) ScopeSQL(sqlText, namespace string) string {
	if namespace == "" || strings.HasPrefix(strings.ToUpper(strings.TrimSpace(sqlText)), "USE ") {
		return sqlText
	}
	return fmt.Sprintf("USE %s; %s", quoteIdentifier(namespace), sqlText)
}

// ListDatabases 列出所有数据库
func (a *MySQLAdapter) ListDatabases() ([]string, error) {
	var dbs []string
	err := a.db.Select(&dbs, "SHOW DATABASES")
	if err != nil {
		return nil, fmt.Errorf("list databases: %w", err)
	}
	return dbs, nil
}

// ListTables 列出当前数据库的所有表
func (a *MySQLAdapter) ListTables(database string) ([]TableInfo, error) {
	if database == "" {
		database = a.conn.Database
	}
	var tables []TableInfo
	err := a.db.Select(&tables, mysqlListTablesQuery, database)
	if err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	return tables, nil
}

// ListColumns 列出表的所有列
func (a *MySQLAdapter) ListColumns(database, table string) ([]ColumnMeta, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := `SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_KEY,
		COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION
		FROM information_schema.COLUMNS 
		WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
		ORDER BY ORDINAL_POSITION`
	var cols []ColumnMeta
	err := a.db.Select(&cols, query, database, table)
	if err != nil {
		return nil, fmt.Errorf("list columns: %w", err)
	}
	return cols, nil
}

// ListIndexes 列出表的索引
func (a *MySQLAdapter) ListIndexes(database, table string) ([]IndexInfo, error) {
	if database == "" {
		database = a.conn.Database
	}
	var indexes []IndexInfo
	err := a.db.Select(&indexes, "SHOW INDEX FROM "+qualifiedIdentifier(database, table))
	if err != nil {
		return nil, fmt.Errorf("list indexes: %w", err)
	}
	return indexes, nil
}

// CreateIndex 创建索引
func (a *MySQLAdapter) CreateIndex(database, table, indexName string, columns []string, unique bool, indexType string) error {
	if database == "" {
		database = a.conn.Database
	}
	if indexType == "" {
		indexType = "BTREE"
	}
	indexType = strings.ToUpper(indexType)
	if indexType != "BTREE" && indexType != "HASH" {
		return fmt.Errorf("unsupported index type: %s", indexType)
	}
	cols := make([]string, len(columns))
	for i, c := range columns {
		cols[i] = quoteIdentifier(c)
	}
	uniqueStr := ""
	if unique {
		uniqueStr = "UNIQUE "
	}
	query := fmt.Sprintf("CREATE %sINDEX %s ON %s (%s) USING %s",
		uniqueStr, quoteIdentifier(indexName), qualifiedIdentifier(database, table), strings.Join(cols, ", "), indexType)
	_, err := a.db.Exec(query)
	if err != nil {
		return fmt.Errorf("create index: %w", err)
	}
	return nil
}

// DropIndex 删除索引
func (a *MySQLAdapter) DropIndex(database, table, indexName string) error {
	if database == "" {
		database = a.conn.Database
	}
	query := fmt.Sprintf("DROP INDEX %s ON %s", quoteIdentifier(indexName), qualifiedIdentifier(database, table))
	_, err := a.db.Exec(query)
	if err != nil {
		return fmt.Errorf("drop index: %w", err)
	}
	return nil
}

// Execute 执行 SQL（支持多语句分号分割）
func (a *MySQLAdapter) Execute(sqlStr string) (*QueryResult, error) {
	start := time.Now()

	sqlStr = strings.TrimSpace(sqlStr)
	if sqlStr == "" {
		return &QueryResult{Error: "empty SQL"}, nil
	}

	// 判断是否是 SELECT 查询（跳过前置的 USE db; 语句）
	checkStr := sqlStr
	upper := strings.ToUpper(sqlStr)
	if strings.HasPrefix(upper, "USE ") {
		if idx := strings.Index(sqlStr, ";"); idx != -1 {
			checkStr = strings.TrimSpace(sqlStr[idx+1:])
		}
	}
	upperCheck := strings.ToUpper(checkStr)
	isSelect := strings.HasPrefix(upperCheck, "SELECT") ||
		strings.HasPrefix(upperCheck, "SHOW") ||
		strings.HasPrefix(upperCheck, "DESCRIBE") ||
		strings.HasPrefix(upperCheck, "EXPLAIN")

	if isSelect {
		if !limitRegex.MatchString(checkStr) && !isSafeSystemQuery(checkStr) {
			sqlStr = sqlStr + " LIMIT 100"
		}
		return a.executeSelect(sqlStr, start)
	}
	return a.executeExec(sqlStr, start)
}

// isSafeSystemQuery 判断是否是已知有界 / 系统级 SHOW 查询,无需 LIMIT 保护。
// 这些语句返回行数固定有限(最多几百行),不会被恶意拉爆;同时仪表盘
// `SHOW GLOBAL STATUS` / `SHOW GLOBAL VARIABLES` 包含 400+ 个 status 变量,
// 强行 LIMIT 100 会把 `Threads_connected` / `Uptime` / `Queries` 等关键
// 指标全部截断,导致仪表盘数字全 0。
func isSafeSystemQuery(sqlStr string) bool {
	upper := strings.ToUpper(strings.TrimSpace(sqlStr))
	patterns := []string{
		"SHOW GLOBAL STATUS",
		"SHOW GLOBAL VARIABLES",
		"SHOW SESSION STATUS",
		"SHOW SESSION VARIABLES",
		"SHOW STATUS",
		"SHOW VARIABLES",
		"SHOW ENGINE INNODB STATUS",
		"SHOW ENGINE INNODB MUTEX",
		"SHOW ENGINE INNODB SYS",
		"SHOW MASTER STATUS",
		"SHOW SLAVE STATUS",
		"SHOW REPLICA STATUS",
		"SHOW BINARY LOGS",
		"SHOW BINLOG EVENTS",
		"SHOW PROCESSLIST",
		"SHOW FULL PROCESSLIST",
		"SHOW GRANTS",
		"SHOW PRIVILEGES",
		"SHOW EVENTS",
		"SHOW TRIGGERS",
		"SHOW PROCEDURE STATUS",
		"SHOW FUNCTION STATUS",
		"SHOW TABLE STATUS",
		"SHOW WARNINGS",
		"SHOW ERRORS",
		"SHOW PLUGINS",
		"SHOW ENGINES",
		"SHOW CHARSET",
		"SHOW COLLATION",
	}
	for _, p := range patterns {
		if strings.HasPrefix(upper, p) {
			return true
		}
	}
	return false
}

func (a *MySQLAdapter) executeSelect(sqlStr string, start time.Time) (*QueryResult, error) {
	return a.executeSelectArgs(sqlStr, nil, start)
}

func (a *MySQLAdapter) executeSelectArgs(sqlStr string, args []interface{}, start time.Time) (*QueryResult, error) {
	rows, err := a.db.Queryx(sqlStr, args...)
	if err != nil {
		return &QueryResult{
			Error:      err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
			IsSelect:   true,
		}, nil
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return &QueryResult{Error: err.Error(), DurationMs: time.Since(start).Milliseconds()}, nil
	}

	colInfos := make([]ColumnInfo, len(columns))
	for i, name := range columns {
		colInfos[i] = ColumnInfo{Name: name}
	}
	colTypes, _ := rows.ColumnTypes()

	var resultRows [][]interface{}
	for rows.Next() {
		values, err := rows.SliceScan()
		if err != nil {
			return &QueryResult{Error: err.Error(), DurationMs: time.Since(start).Milliseconds()}, nil
		}
		// 转换驱动原生值为前端可编辑、MySQL 可写回的展示值。
		for i, v := range values {
			dbType := ""
			if i < len(colTypes) && colTypes[i] != nil {
				dbType = colTypes[i].DatabaseTypeName()
				colInfos[i].Type = dbType
			}
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			} else if t, ok := v.(time.Time); ok {
				values[i] = formatMySQLTimeValue(t, dbType)
			}
		}
		resultRows = append(resultRows, values)
	}
	if err := rows.Err(); err != nil {
		return &QueryResult{Error: err.Error(), DurationMs: time.Since(start).Milliseconds()}, nil
	}

	return &QueryResult{
		Columns:    colInfos,
		Rows:       resultRows,
		IsSelect:   true,
		DurationMs: time.Since(start).Milliseconds(),
	}, nil
}

func (a *MySQLAdapter) executeExec(sqlStr string, start time.Time) (*QueryResult, error) {
	result, err := a.db.Exec(sqlStr)
	if err != nil {
		return &QueryResult{
			Error:      err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
		}, nil
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
func (a *MySQLAdapter) Explain(sqlStr string) (*QueryResult, error) {
	return a.executeSelect("EXPLAIN "+sqlStr, time.Now())
}

// GetTableDDL 获取建表 DDL
func (a *MySQLAdapter) GetTableDDL(database, table string) (string, error) {
	if database == "" {
		database = a.conn.Database
	}
	var tableName, ddl string
	err := a.db.QueryRow("SHOW CREATE TABLE "+qualifiedIdentifier(database, table)).Scan(&tableName, &ddl)
	if err != nil {
		return "", fmt.Errorf("get ddl: %w", err)
	}
	return ddl, nil
}

// GetTableData 分页获取表数据
// filter: 全局文本搜索,对所有文本列做 LIKE 匹配
// columnFilters: 精确列筛选,对指定列做 = 匹配
// quickFilter: 快捷筛选关键字,对所有列做 LIKE '%kw%' 模糊匹配
func (a *MySQLAdapter) GetTableData(database, table string, limit, offset int, orderBy, orderDir, filter, quickFilter string, columnFilters map[string]string) (*QueryResult, error) {
	if database == "" {
		database = a.conn.Database
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 10000 {
		limit = 10000
	}

	query := "SELECT * FROM " + qualifiedIdentifier(database, table)

	// Build WHERE clause
	var conditions []string
	var args []interface{}

	// 用户输入的 raw WHERE 条件(如: name = 'test' AND age > 18)
	if filter != "" {
		conditions = append(conditions, "("+filter+")")
	}

	// 列头精确筛选
	if len(columnFilters) > 0 {
		for col, val := range columnFilters {
			conditions = append(conditions, fmt.Sprintf("%s = ?", quoteIdentifier(col)))
			args = append(args, val)
		}
	}

	// 快捷筛选:所有列 LIKE '%kw%'(列名来自 information_schema,参数化防注入)
	if quickFilter != "" {
		cols, err := a.ListColumns(database, table)
		if err != nil {
			return nil, fmt.Errorf("quick filter: %w", err)
		}
		var likeParts []string
		for _, c := range cols {
			if c.Name == "" {
				continue
			}
			likeParts = append(likeParts, fmt.Sprintf("%s LIKE ?", quoteIdentifier(c.Name)))
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
		query += fmt.Sprintf(" ORDER BY %s %s", quoteIdentifier(orderBy), dir)
	}
	query += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)

	log.Info().Str("sql", query).Str("filter", filter).Interface("columnFilters", columnFilters).Msg("GetTableData query")

	var result *QueryResult
	var execErr error
	if len(args) > 0 {
		result, execErr = a.executeSelectArgs(query, args, time.Now())
	} else {
		result, execErr = a.executeSelect(query, time.Now())
	}
	if execErr != nil {
		return nil, fmt.Errorf("get table data: %w", execErr)
	}

	// When filters are active, also return filtered row count for pagination
	if whereClause != "" && result.Error == "" {
		countQuery := "SELECT COUNT(*) FROM " + qualifiedIdentifier(database, table) + whereClause
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
func (a *MySQLAdapter) GetRowCount(database, table string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	var count int64
	err := a.db.Get(&count, "SELECT COUNT(*) FROM "+qualifiedIdentifier(database, table))
	return count, err
}

// GetTableMeta 批量获取表元信息（列元数据 + 行数），并行查询减少延迟
func (a *MySQLAdapter) GetTableMeta(database, table string) (*TableMeta, error) {
	if database == "" {
		database = a.conn.Database
	}
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
func (a *MySQLAdapter) DropTable(database, table string, ifExists bool) error {
	if database == "" {
		database = a.conn.Database
	}
	stmt := "DROP TABLE"
	if ifExists {
		stmt += " IF EXISTS"
	}
	stmt += " " + qualifiedIdentifier(database, table)
	_, err := a.db.Exec(stmt)
	return err
}

// TruncateTable 清空表
func (a *MySQLAdapter) TruncateTable(database, table string) error {
	if database == "" {
		database = a.conn.Database
	}
	_, err := a.db.Exec("TRUNCATE TABLE " + qualifiedIdentifier(database, table))
	return err
}

// RenameTable 重命名表
func (a *MySQLAdapter) RenameTable(database, oldName, newName string) error {
	if database == "" {
		database = a.conn.Database
	}
	_, err := a.db.Exec("RENAME TABLE " + qualifiedIdentifier(database, oldName) + " TO " + qualifiedIdentifier(database, newName))
	return err
}

func (a *MySQLAdapter) columnDataTypeMap(database, table string) (map[string]string, error) {
	cols, err := a.ListColumns(database, table)
	if err != nil {
		return nil, fmt.Errorf("list columns: %w", err)
	}
	types := make(map[string]string, len(cols))
	for _, col := range cols {
		types[strings.ToLower(col.Name)] = strings.ToLower(col.DataType)
	}
	return types, nil
}

func formatMySQLTimeValue(value time.Time, dbType string) string {
	switch strings.ToLower(dbType) {
	case "date":
		return value.Format("2006-01-02")
	case "time":
		return formatMySQLFraction(value, "15:04:05")
	default:
		return formatMySQLFraction(value, "2006-01-02 15:04:05")
	}
}

func formatMySQLFraction(value time.Time, layout string) string {
	formatted := value.Format(layout)
	microsecond := value.Nanosecond() / 1000
	if microsecond == 0 {
		return formatted
	}
	fraction := strings.TrimRight(fmt.Sprintf("%06d", microsecond), "0")
	return formatted + "." + fraction
}

func normalizeMySQLInputValue(value interface{}, dataType string) interface{} {
	if value == nil {
		return nil
	}
	if t, ok := value.(time.Time); ok {
		return formatMySQLTimeValue(t, dataType)
	}
	s, ok := value.(string)
	if !ok {
		return value
	}
	if strings.EqualFold(s, "NULL") {
		return nil
	}
	if !isMySQLTemporalType(dataType) {
		return value
	}
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return value
	}
	if parsed, ok := parseMySQLTemporalString(trimmed); ok {
		return formatMySQLTimeValue(parsed, dataType)
	}
	if dataType == "datetime" || dataType == "timestamp" {
		return strings.Replace(trimmed, "T", " ", 1)
	}
	return value
}

func isMySQLTemporalType(dataType string) bool {
	switch strings.ToLower(dataType) {
	case "date", "datetime", "timestamp", "time":
		return true
	default:
		return false
	}
}

func parseMySQLTemporalString(value string) (time.Time, bool) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02",
		"15:04:05.999999999",
		"15:04:05",
	}
	for _, layout := range layouts {
		if parsed, err := time.ParseInLocation(layout, value, time.UTC); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

// UpdateRows 批量更新行
func (a *MySQLAdapter) UpdateRows(database, table string, sets map[string]interface{}, where string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	columnTypes, err := a.columnDataTypeMap(database, table)
	if err != nil {
		return 0, err
	}
	setParts := make([]string, 0, len(sets))
	args := make([]interface{}, 0, len(sets))
	for col, val := range sets {
		setParts = append(setParts, fmt.Sprintf("%s = ?", quoteIdentifier(col)))
		args = append(args, normalizeMySQLInputValue(val, columnTypes[strings.ToLower(col)]))
	}

	query := fmt.Sprintf("UPDATE %s SET %s", qualifiedIdentifier(database, table), strings.Join(setParts, ", "))
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
func (a *MySQLAdapter) DeleteRows(database, table, where string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := "DELETE FROM " + qualifiedIdentifier(database, table)
	if where != "" {
		query += " WHERE " + where
	}
	result, err := a.db.Exec(query)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// InsertRow 插入一行
func (a *MySQLAdapter) InsertRow(database, table string, values map[string]interface{}) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	columnTypes, err := a.columnDataTypeMap(database, table)
	if err != nil {
		return 0, err
	}
	cols := make([]string, 0, len(values))
	placeholders := make([]string, 0, len(values))
	args := make([]interface{}, 0, len(values))
	for col, val := range values {
		cols = append(cols, quoteIdentifier(col))
		placeholders = append(placeholders, "?")
		args = append(args, normalizeMySQLInputValue(val, columnTypes[strings.ToLower(col)]))
	}

	query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedIdentifier(database, table),
		strings.Join(cols, ", "), strings.Join(placeholders, ", "))
	result, err := a.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// ExportCSV 导出表为 CSV（返回 JSON 编码的结果）
func (a *MySQLAdapter) ExportCSV(database, table string, limit int) (*QueryResult, error) {
	if database == "" {
		database = a.conn.Database
	}
	if limit <= 0 {
		limit = 100000
	}
	query := fmt.Sprintf("SELECT * FROM %s LIMIT %d", qualifiedIdentifier(database, table), limit)
	return a.executeSelect(query, time.Now())
}

// ExportJSON 导出表为 JSON
func (a *MySQLAdapter) ExportJSON(database, table string, limit int) (string, error) {
	result, err := a.ExportCSV(database, table, limit)
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

// exportExcelSelectBase 构建 SELECT 查询基础(WHERE/ORDER BY,不含 LIMIT/OFFSET),
// 返回拼接好的 query 字符串与参数。语义与 GetTableData 完全一致:
//   - filter: raw WHERE 条件,包裹在括号内
//   - columnFilters: 列 → 值 精确匹配,追加为 `col = ?`
//   - orderBy + orderDir: 排序
func (a *MySQLAdapter) exportExcelSelectBase(database, table, filter, orderBy, orderDir string, columnFilters map[string]string) (string, []interface{}) {
	query := "SELECT * FROM " + qualifiedIdentifier(database, table)

	var conditions []string
	var args []interface{}

	if filter != "" {
		conditions = append(conditions, "("+filter+")")
	}
	for col, val := range columnFilters {
		conditions = append(conditions, fmt.Sprintf("%s = ?", quoteIdentifier(col)))
		args = append(args, val)
	}
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}

	if orderBy != "" {
		dir := "ASC"
		if strings.ToUpper(orderDir) == "DESC" {
			dir = "DESC"
		}
		query += fmt.Sprintf(" ORDER BY %s %s", quoteIdentifier(orderBy), dir)
	}
	return query, args
}

// ExportExcel 将表全量导出为 .xlsx 文件(服务端直写磁盘)。
// 使用流式 writer + 服务端 LIMIT/OFFSET 分页(默认每批 10000 行),避免大表整表载入内存。
// 返回导出的总行数。
func (a *MySQLAdapter) ExportExcel(database, table, filePath, filter string, columnFilters map[string]string, orderBy, orderDir string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}

	baseQuery, baseArgs := a.exportExcelSelectBase(database, table, filter, orderBy, orderDir, columnFilters)

	f := excelize.NewFile()
	sheet := "Sheet1"
	sw, err := f.NewStreamWriter(sheet)
	if err != nil {
		return 0, fmt.Errorf("excel: new stream writer: %w", err)
	}

	const batchSize = 10000
	var total int64

	// 写表头(列名)。StreamWriter 需严格按轴顺序写入。
	headers, hdrErr := a.exportExcelHeaders(database, table)
	if hdrErr != nil {
		_ = sw.Flush()
		_ = f.Close()
		return 0, hdrErr
	}
	headerRow := make([]interface{}, len(headers))
	for i, h := range headers {
		headerRow[i] = h
	}
	if err := writeStreamRow(sw, 1, headerRow); err != nil {
		_ = f.Close()
		return 0, err
	}
	total++ // 表头不计入数据行,后续基于 total 计算行号

	for offset := 0; ; offset += batchSize {
		query := fmt.Sprintf("%s LIMIT %d OFFSET %d", baseQuery, batchSize, offset)
		var result *QueryResult
		var execErr error
		if len(baseArgs) > 0 {
			result, execErr = a.executeSelectArgs(query, baseArgs, time.Now())
		} else {
			result, execErr = a.executeSelect(query, time.Now())
		}
		if execErr != nil {
			_ = sw.Flush()
			_ = f.Close()
			return 0, fmt.Errorf("export excel: %w", execErr)
		}
		if result.Error != "" {
			_ = sw.Flush()
			_ = f.Close()
			return 0, fmt.Errorf("export excel: %s", result.Error)
		}

		rows := result.Rows
		if len(rows) == 0 {
			break
		}
		for _, row := range rows {
			vals := make([]interface{}, len(row))
			for i, v := range row {
				vals[i] = excelSerializableValue(v)
			}
			if err := writeStreamRow(sw, int(total+1), vals); err != nil {
				_ = f.Close()
				return 0, err
			}
			total++
		}
		if len(rows) < batchSize {
			break
		}
	}

	if err := sw.Flush(); err != nil {
		_ = f.Close()
		return 0, fmt.Errorf("excel: flush stream writer: %w", err)
	}

	dataRows := total - 1 // 减去表头行

	if err := os.MkdirAll(fileDir(filePath), 0o755); err != nil {
		_ = f.Close()
		return 0, fmt.Errorf("export excel: create dir: %w", err)
	}
	if err := f.SaveAs(filePath); err != nil {
		_ = f.Close()
		return 0, fmt.Errorf("export excel: save file: %w", err)
	}
	if err := f.Close(); err != nil {
		return 0, fmt.Errorf("export excel: close file: %w", err)
	}
	return dataRows, nil
}

// exportExcelHeaders 返回导出表头(列名)列表。
func (a *MySQLAdapter) exportExcelHeaders(database, table string) ([]string, error) {
	cols, err := a.ListColumns(database, table)
	if err != nil {
		return nil, fmt.Errorf("export excel: list columns: %w", err)
	}
	headers := make([]string, len(cols))
	for i, c := range cols {
		headers[i] = c.Name
	}
	return headers, nil
}

// writeStreamRow 按指定行号把一行值写入流式 writer(nil 值写为空单元格)。
func writeStreamRow(sw *excelize.StreamWriter, row int, vals []interface{}) error {
	cell, err := excelize.CoordinatesToCellName(1, row)
	if err != nil {
		return fmt.Errorf("excel: cell name: %w", err)
	}
	clean := make([]interface{}, len(vals))
	for i, v := range vals {
		if v == nil {
			clean[i] = ""
		} else {
			clean[i] = v
		}
	}
	return sw.SetRow(cell, clean)
}

// excelSerializableValue 将驱动原生值转换为 excelize 可写的序列化形式。
func excelSerializableValue(v interface{}) interface{} {
	if v == nil {
		return nil
	}
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.Format("2006-01-02 15:04:05")
	default:
		return v
	}
}

// fileDir 返回文件所在目录(空路径时返回 ".")。
func fileDir(p string) string {
	idx := strings.LastIndexAny(p, "/\\")
	if idx < 0 {
		return "."
	}
	return p[:idx]
}
