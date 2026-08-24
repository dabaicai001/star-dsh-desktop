package adapters

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/jmoiron/sqlx"
	"github.com/rs/zerolog/log"
	"github.com/xuri/excelize/v2"
)

// ClickHouseAdapter 封装 ClickHouse 连接
type ClickHouseAdapter struct {
	db   *sqlx.DB
	conn *ClickHouseConnInfo
}

// ClickHouseConnInfo ClickHouse 连接参数
type ClickHouseConnInfo struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	Database string `json:"database,omitempty"`
	SSL      bool   `json:"ssl,omitempty"`
}

// CHColumnMeta ClickHouse 列元数据（中间类型，用于从 system.columns 查询）
type CHColumnMeta struct {
	Name         string `json:"name" db:"name"`
	Type         string `json:"type" db:"type"`
	DefaultKind  string `json:"defaultKind" db:"default_kind"`
	DefaultExpr  string `json:"defaultExpr" db:"default_expression"`
	Comment      string `json:"comment" db:"comment"`
	Position     int    `json:"position" db:"position"`
	InPrimaryKey bool   `json:"inPrimaryKey" db:"is_in_primary_key"`
}

// ToColumnMeta 转换为通用 ColumnMeta
func (c CHColumnMeta) ToColumnMeta() ColumnMeta {
	var defaultVal *string
	if c.DefaultExpr != "" {
		defaultVal = &c.DefaultExpr
	}
	nullable := "NO"
	if strings.HasPrefix(c.Type, "Nullable(") {
		nullable = "YES"
	}
	// ClickHouse 无传统主键概念,把 ORDER BY / PRIMARY KEY 键列标记为 PRI,
	// 前端据此放行标签页内行编辑(ALTER TABLE ... UPDATE mutation)
	key := ""
	if c.InPrimaryKey {
		key = "PRI"
	}
	return ColumnMeta{
		Name:         c.Name,
		Type:         c.Type,
		DataType:     extractBaseType(c.Type),
		Nullable:     nullable,
		Key:          key,
		DefaultValue: defaultVal,
		Extra:        c.DefaultKind,
		Comment:      c.Comment,
		OrdinalPos:   c.Position,
	}
}

// PartitionInfo 分区信息
type PartitionInfo struct {
	Partition   string `json:"partition" db:"partition"`
	Name        string `json:"name" db:"name"`
	Rows        int64  `json:"rows" db:"rows"`
	SizeInBytes int64  `json:"sizeInBytes" db:"size_in_bytes"`
}

// MergeTreeInfo MergeTree 引擎信息
type MergeTreeInfo struct {
	Engine       string `json:"engine" db:"engine"`
	SortingKey   string `json:"sortingKey" db:"sorting_key"`
	PartitionKey string `json:"partitionKey" db:"partition_key"`
	PrimaryKey   string `json:"primaryKey" db:"primary_key"`
}

// TableStats 表统计信息
type TableStats struct {
	TotalRows      int64  `json:"totalRows" db:"total_rows"`
	TotalBytes     int64  `json:"totalBytes" db:"total_bytes"`
	TotalCols      int64  `json:"totalCols" db:"total_cols"`
	PartsCount     int64  `json:"partsCount" db:"parts_count"`
	Engine         string `json:"engine" db:"engine"`
	LastModifyTime string `json:"lastModifyTime,omitempty" db:"last_modify_time"`
}

const clickHouseListTablesQuery = `SELECT name, engine as type, engine,
		coalesce(total_rows, 0) as rows, coalesce(comment, '') as comment
		FROM system.tables WHERE database = ? ORDER BY name`

// extractBaseType 从 Nullable(UInt8) 等提取基础类型
func extractBaseType(chType string) string {
	if strings.HasPrefix(chType, "Nullable(") {
		return strings.TrimSuffix(strings.TrimPrefix(chType, "Nullable("), ")")
	}
	if strings.HasPrefix(chType, "LowCardinality(") {
		return strings.TrimSuffix(strings.TrimPrefix(chType, "LowCardinality("), ")")
	}
	if strings.HasPrefix(chType, "Array(") {
		return "Array"
	}
	if strings.HasPrefix(chType, "Map(") {
		return "Map"
	}
	return chType
}

// NewClickHouseAdapter 创建 ClickHouse 适配器
func NewClickHouseAdapter(info *ClickHouseConnInfo) (*ClickHouseAdapter, error) {
	if info.Port == 0 {
		info.Port = 9000
	}

	opts := &clickhouse.Options{
		Addr: []string{fmt.Sprintf("%s:%d", info.Host, info.Port)},
		Auth: clickhouse.Auth{
			Database: info.Database,
			Username: info.Username,
			Password: info.Password,
		},
		Settings: clickhouse.Settings{
			"connect_timeout": 10,
			"receive_timeout": 30,
			"send_timeout":    30,
		},
		DialTimeout:     10 * time.Second,
		MaxOpenConns:    10,
		MaxIdleConns:    5,
		ConnMaxLifetime: 30 * time.Minute,
	}

	if info.SSL {
		opts.TLS = &tls.Config{
			InsecureSkipVerify: false,
		}
	}

	conn := clickhouse.OpenDB(opts)
	db := sqlx.NewDb(conn, "clickhouse")

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("clickhouse connect failed: %w", err)
	}

	log.Info().Str("host", info.Host).Int("port", info.Port).Str("db", info.Database).Msg("clickhouse connected")

	return &ClickHouseAdapter{db: db, conn: info}, nil
}

// Close 关闭连接
func (a *ClickHouseAdapter) Close() error {
	return a.db.Close()
}

// Ping 检测连接
func (a *ClickHouseAdapter) Ping() error {
	return a.db.Ping()
}

// ListDatabases 列出所有数据库
func (a *ClickHouseAdapter) ListDatabases() ([]string, error) {
	var dbs []string
	err := a.db.Select(&dbs, "SELECT name FROM system.databases ORDER BY name")
	if err != nil {
		return nil, fmt.Errorf("list databases: %w", err)
	}
	return dbs, nil
}

// ListTables 列出当前数据库的所有表
func (a *ClickHouseAdapter) ListTables(database string) ([]TableInfo, error) {
	if database == "" {
		database = a.conn.Database
	}
	var tables []TableInfo
	err := a.db.Select(&tables, clickHouseListTablesQuery, database)
	if err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	return tables, nil
}

// ListColumns 列出表的所有列
func (a *ClickHouseAdapter) ListColumns(database, table string) ([]ColumnMeta, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := `SELECT name, type, default_kind, default_expression, comment, position,
			is_in_primary_key
		FROM system.columns 
		WHERE database = ? AND table = ?
		ORDER BY position`
	var chCols []CHColumnMeta
	err := a.db.Select(&chCols, query, database, table)
	if err != nil {
		return nil, fmt.Errorf("list columns: %w", err)
	}
	cols := make([]ColumnMeta, len(chCols))
	for i, c := range chCols {
		cols[i] = c.ToColumnMeta()
	}
	return cols, nil
}

// ListIndexes 列出表的索引（ClickHouse 无传统索引，返回空）
func (a *ClickHouseAdapter) ListIndexes(database, table string) ([]IndexInfo, error) {
	return []IndexInfo{}, nil
}

// CreateIndex 创建索引（ClickHouse 不支持传统索引）
func (a *ClickHouseAdapter) CreateIndex(database, table, indexName string, columns []string, unique bool, indexType string) error {
	return fmt.Errorf("ClickHouse does not support traditional indexes")
}

// DropIndex 删除索引（ClickHouse 不支持传统索引）
func (a *ClickHouseAdapter) DropIndex(database, table, indexName string) error {
	return fmt.Errorf("ClickHouse does not support traditional indexes")
}

// Execute 执行 SQL
func (a *ClickHouseAdapter) Execute(sqlStr string) (*QueryResult, error) {
	start := time.Now()

	sqlStr = strings.TrimSpace(sqlStr)
	if sqlStr == "" {
		return &QueryResult{Error: "empty SQL"}, nil
	}

	upper := strings.ToUpper(sqlStr)
	isSelect := strings.HasPrefix(upper, "SELECT") ||
		strings.HasPrefix(upper, "SHOW") ||
		strings.HasPrefix(upper, "DESCRIBE") ||
		strings.HasPrefix(upper, "EXPLAIN")

	if isSelect {
		if !strings.Contains(strings.ToUpper(sqlStr), "LIMIT") {
			sqlStr = sqlStr + " LIMIT 100"
		}
		return a.executeSelect(sqlStr, start)
	}
	return a.executeExec(sqlStr, start)
}

func (a *ClickHouseAdapter) executeSelect(sqlStr string, start time.Time) (*QueryResult, error) {
	return a.executeSelectArgs(sqlStr, nil, start)
}

func (a *ClickHouseAdapter) executeSelectArgs(sqlStr string, args []interface{}, start time.Time) (*QueryResult, error) {
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

	var resultRows [][]interface{}
	for rows.Next() {
		values, err := rows.SliceScan()
		if err != nil {
			return &QueryResult{Error: err.Error(), DurationMs: time.Since(start).Milliseconds()}, nil
		}
		// 转换 []byte 为 string
		for i, v := range values {
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
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

func (a *ClickHouseAdapter) executeExec(sqlStr string, start time.Time) (*QueryResult, error) {
	result, err := a.db.Exec(sqlStr)
	if err != nil {
		return &QueryResult{
			Error:      err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
		}, nil
	}

	affected, _ := result.RowsAffected()

	return &QueryResult{
		RowsAffected: affected,
		DurationMs:   time.Since(start).Milliseconds(),
	}, nil
}

// Explain 获取执行计划
func (a *ClickHouseAdapter) Explain(sqlStr string) (*QueryResult, error) {
	return a.executeSelect("EXPLAIN "+sqlStr, time.Now())
}

// GetTableDDL 获取建表 DDL
func (a *ClickHouseAdapter) GetTableDDL(database, table string) (string, error) {
	if database == "" {
		database = a.conn.Database
	}
	var ddl string
	err := a.db.QueryRow("SHOW CREATE TABLE " + qualifiedIdentifier(database, table)).Scan(&ddl)
	if err != nil {
		return "", fmt.Errorf("get ddl: %w", err)
	}
	return ddl, nil
}

// GetTableData 分页获取表数据
func (a *ClickHouseAdapter) GetTableData(database, table string, limit, offset int, orderBy, orderDir, filter, quickFilter string, columnFilters map[string]string) (*QueryResult, error) {
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

	// 用户输入的 raw WHERE 条件
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

	// 快捷筛选:所有列 lower(toString(col)) LIKE lower('%kw%')(列名来自 system.columns,
	// 参数化防注入;ClickHouse LIKE 大小写敏感,两侧 lower 对齐)
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
			likeParts = append(likeParts, fmt.Sprintf("lower(CAST(%s AS String)) LIKE lower(?)", quoteIdentifier(c.Name)))
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
func (a *ClickHouseAdapter) GetRowCount(database, table string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	var count int64
	err := a.db.Get(&count, "SELECT COUNT(*) FROM "+qualifiedIdentifier(database, table))
	return count, err
}

// GetTableMeta 批量获取表元信息（列元数据 + 行数），并行查询减少延迟
func (a *ClickHouseAdapter) GetTableMeta(database, table string) (*TableMeta, error) {
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
func (a *ClickHouseAdapter) DropTable(database, table string, ifExists bool) error {
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
func (a *ClickHouseAdapter) TruncateTable(database, table string) error {
	if database == "" {
		database = a.conn.Database
	}
	_, err := a.db.Exec("TRUNCATE TABLE " + qualifiedIdentifier(database, table))
	return err
}

// RenameTable 重命名表
func (a *ClickHouseAdapter) RenameTable(database, oldName, newName string) error {
	if database == "" {
		database = a.conn.Database
	}
	_, err := a.db.Exec("RENAME TABLE " + qualifiedIdentifier(database, oldName) + " TO " + qualifiedIdentifier(database, newName))
	return err
}

// InsertRow 插入一行
func (a *ClickHouseAdapter) InsertRow(database, table string, values map[string]interface{}) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	cols := make([]string, 0, len(values))
	placeholders := make([]string, 0, len(values))
	args := make([]interface{}, 0, len(values))
	for col, val := range values {
		cols = append(cols, quoteIdentifier(col))
		placeholders = append(placeholders, "?")
		args = append(args, val)
	}

	query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedIdentifier(database, table),
		strings.Join(cols, ", "), strings.Join(placeholders, ", "))
	_, err := a.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	// ClickHouse 没有 auto-increment，返回 0
	return 0, nil
}

// UpdateRows 更新行（ClickHouse 使用 ALTER TABLE UPDATE 异步 mutation）
func (a *ClickHouseAdapter) UpdateRows(database, table string, sets map[string]interface{}, where string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	setParts := make([]string, 0, len(sets))
	args := make([]interface{}, 0, len(sets))
	for col, val := range sets {
		setParts = append(setParts, fmt.Sprintf("%s = ?", quoteIdentifier(col)))
		args = append(args, val)
	}

	query := fmt.Sprintf("ALTER TABLE %s UPDATE %s", qualifiedIdentifier(database, table), strings.Join(setParts, ", "))
	if where != "" {
		query += " WHERE " + where
	}

	_, err := a.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	// ClickHouse mutations are async, rowsAffected not available
	return 0, nil
}

// DeleteRows 删除行（ClickHouse 使用 ALTER TABLE DELETE 异步 mutation）
func (a *ClickHouseAdapter) DeleteRows(database, table, where string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := "ALTER TABLE " + qualifiedIdentifier(database, table) + " DELETE"
	if where != "" {
		query += " WHERE " + where
	}
	_, err := a.db.Exec(query)
	if err != nil {
		return 0, err
	}
	// ClickHouse mutations are async, rowsAffected not available
	return 0, nil
}

// ExportCSV 导出表为 CSV（返回 JSON 编码的结果）
func (a *ClickHouseAdapter) ExportCSV(database, table string, limit int) (*QueryResult, error) {
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
func (a *ClickHouseAdapter) ExportJSON(database, table string, limit int) (string, error) {
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

// GetPartitions 获取表的分区信息
func (a *ClickHouseAdapter) GetPartitions(database, table string) ([]PartitionInfo, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := `SELECT partition, name, rows, size_in_bytes 
		FROM system.parts 
		WHERE database = ? AND table = ? AND active = 1
		ORDER BY partition, name`
	var partitions []PartitionInfo
	err := a.db.Select(&partitions, query, database, table)
	if err != nil {
		return nil, fmt.Errorf("get partitions: %w", err)
	}
	return partitions, nil
}

// GetMergeTreeInfo 获取 MergeTree 引擎信息
func (a *ClickHouseAdapter) GetMergeTreeInfo(database, table string) (*MergeTreeInfo, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := `SELECT engine, sorting_key, partition_key, primary_key 
		FROM system.tables 
		WHERE database = ? AND table = ?`
	var info MergeTreeInfo
	err := a.db.Get(&info, query, database, table)
	if err != nil {
		return nil, fmt.Errorf("get mergetree info: %w", err)
	}
	return &info, nil
}

// GetTableStats 获取表统计信息
func (a *ClickHouseAdapter) GetTableStats(database, table string) (*TableStats, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := `SELECT 
		coalesce(total_rows, 0) AS total_rows,
		coalesce(total_bytes, 0) AS total_bytes,
		coalesce(total_columns, 0) AS total_cols,
		coalesce(parts_count, 0) AS parts_count,
		engine
		FROM system.tables 
		WHERE database = ? AND table = ?`
	var stats TableStats
	err := a.db.Get(&stats, query, database, table)
	if err != nil {
		return nil, fmt.Errorf("get table stats: %w", err)
	}
	return &stats, nil
}

// exportExcelSelectBase 构建 SELECT 查询基础(WHERE/ORDER BY,不含 LIMIT/OFFSET)。
// 语义与 GetTableData 完全一致:filter 为 raw WHERE 条件(括号包裹),
// columnFilters 为 列 → 值 精确匹配(`col = ?`),orderBy + orderDir 排序。
func (a *ClickHouseAdapter) exportExcelSelectBase(database, table, filter, orderBy, orderDir string, columnFilters map[string]string) (string, []interface{}) {
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
func (a *ClickHouseAdapter) ExportExcel(database, table, filePath, filter string, columnFilters map[string]string, orderBy, orderDir string) (int64, error) {
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

	// 写表头
	cols, err := a.ListColumns(database, table)
	if err != nil {
		_ = sw.Flush()
		_ = f.Close()
		return 0, fmt.Errorf("export excel: list columns: %w", err)
	}
	headerRow := make([]interface{}, len(cols))
	for i, c := range cols {
		headerRow[i] = c.Name
	}
	if err := writeStreamRow(sw, 1, headerRow); err != nil {
		_ = f.Close()
		return 0, err
	}
	total++ // 表头行占用行号 1,后续数据从行号 2 起

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
