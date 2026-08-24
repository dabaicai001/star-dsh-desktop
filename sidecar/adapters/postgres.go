package adapters

import (
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/jmoiron/sqlx"
	"github.com/rs/zerolog/log"
)

// PostgresConnInfo PostgreSQL 连接参数。Database 是实际数据库，界面左树按 schema 展示。
type PostgresConnInfo struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	Database string `json:"database,omitempty"`
	SSL      bool   `json:"ssl,omitempty"`
}

type PostgresAdapter struct {
	db   *sqlx.DB
	conn *PostgresConnInfo
}

func NewPostgresAdapter(info *PostgresConnInfo) (*PostgresAdapter, error) {
	if info.Port == 0 {
		info.Port = 5432
	}
	if info.Database == "" {
		info.Database = "postgres"
	}
	dsn := &url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(info.Username, info.Password),
		Host:   fmt.Sprintf("%s:%d", info.Host, info.Port),
		Path:   info.Database,
	}
	query := dsn.Query()
	if info.SSL {
		query.Set("sslmode", "require")
	} else {
		query.Set("sslmode", "disable")
	}
	query.Set("connect_timeout", "10")
	query.Set("default_query_exec_mode", "simple_protocol")
	dsn.RawQuery = query.Encode()

	db, err := sqlx.Connect("pgx", dsn.String())
	if err != nil {
		return nil, fmt.Errorf("postgres connect failed: %w", err)
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	log.Info().Str("host", info.Host).Int("port", info.Port).Str("db", info.Database).
		Msg("postgres connected")
	return &PostgresAdapter{db: db, conn: info}, nil
}

func (a *PostgresAdapter) Close() error { return a.db.Close() }
func (a *PostgresAdapter) Ping() error  { return a.db.Ping() }
func (a *PostgresAdapter) DefaultNamespace() string {
	return "public"
}
func (a *PostgresAdapter) ScopeSQL(sqlText, namespace string) string {
	// search_path 是连接级状态，而 sql.DB 会在连接池中切换物理连接。
	// 表格 CRUD 使用 schema.table 完整限定名；SQL 编辑器保留用户原始语句，
	// 避免在前面拼 SET 后驱动错误地读取第一个结果集。
	return sqlText
}

// ListDatabases 按 PostgreSQL 的可操作层级返回 schema，避免伪装成可跨库查询。
func (a *PostgresAdapter) ListDatabases() ([]string, error) {
	var schemas []string
	err := a.db.Select(&schemas, `SELECT schema_name
		FROM information_schema.schemata
		WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
		  AND schema_name NOT LIKE 'pg_toast%'
		  AND schema_name NOT LIKE 'pg_temp_%'
		ORDER BY schema_name`)
	if err != nil {
		return nil, fmt.Errorf("list postgres schemas: %w", err)
	}
	return schemas, nil
}

func postgresSchema(schema string) string {
	if schema == "" {
		return "public"
	}
	return schema
}

func quotePostgresIdentifier(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}

func qualifiedPostgresIdentifier(schema, table string) string {
	return quotePostgresIdentifier(postgresSchema(schema)) + "." + quotePostgresIdentifier(table)
}

func (a *PostgresAdapter) ListTables(schema string) ([]TableInfo, error) {
	var tables []TableInfo
	err := a.db.Select(&tables, `SELECT
			c.relname AS name,
			CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
				ELSE 'BASE TABLE' END AS type,
			COALESCE(am.amname, '') AS engine,
			COALESCE(c.reltuples, 0)::bigint AS rows,
			COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_am am ON am.oid = c.relam
		WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
		ORDER BY c.relname`, postgresSchema(schema))
	if err != nil {
		return nil, fmt.Errorf("list postgres tables: %w", err)
	}
	return tables, nil
}

func (a *PostgresAdapter) ListColumns(schema, table string) ([]ColumnMeta, error) {
	var columns []ColumnMeta
	err := a.db.Select(&columns, `SELECT
			c.column_name AS "COLUMN_NAME",
			c.udt_name AS "COLUMN_TYPE",
			c.data_type AS "DATA_TYPE",
			c.is_nullable AS "IS_NULLABLE",
			CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 'PRI' ELSE '' END AS "COLUMN_KEY",
			c.column_default AS "COLUMN_DEFAULT",
			COALESCE(c.is_identity, '') AS "EXTRA",
			COALESCE(pgd.description, '') AS "COLUMN_COMMENT",
			c.ordinal_position AS "ORDINAL_POSITION"
		FROM information_schema.columns c
		LEFT JOIN information_schema.key_column_usage kcu
		  ON kcu.table_schema = c.table_schema AND kcu.table_name = c.table_name
		 AND kcu.column_name = c.column_name
		LEFT JOIN information_schema.table_constraints tc
		  ON tc.constraint_schema = kcu.constraint_schema
		 AND tc.constraint_name = kcu.constraint_name
		LEFT JOIN pg_catalog.pg_statio_all_tables st
		  ON st.schemaname = c.table_schema AND st.relname = c.table_name
		LEFT JOIN pg_catalog.pg_description pgd
		  ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
		WHERE c.table_schema = $1 AND c.table_name = $2
		ORDER BY c.ordinal_position`, postgresSchema(schema), table)
	if err != nil {
		return nil, fmt.Errorf("list postgres columns: %w", err)
	}
	return columns, nil
}

func (a *PostgresAdapter) ListIndexes(schema, table string) ([]IndexInfo, error) {
	var indexes []IndexInfo
	err := a.db.Select(&indexes, `SELECT
			t.relname AS "Table",
			CASE WHEN i.indisunique THEN 0 ELSE 1 END AS "Non_unique",
			idx.relname AS "Key_name",
			1 AS "Seq_in_index",
			COALESCE(pg_get_indexdef(i.indexrelid), '') AS "Column_name",
			'A' AS "Collation",
			NULL::bigint AS "Cardinality",
			NULL::bigint AS "Sub_part",
			NULL::text AS "Packed",
			'' AS "Null",
			COALESCE(am.amname, 'btree') AS "Index_type",
			'' AS "Comment",
			COALESCE(obj_description(idx.oid, 'pg_class'), '') AS "Index_comment",
			'YES' AS "Visible",
			NULL::text AS "Expression"
		FROM pg_index i
		JOIN pg_class t ON t.oid = i.indrelid
		JOIN pg_class idx ON idx.oid = i.indexrelid
		JOIN pg_namespace n ON n.oid = t.relnamespace
		LEFT JOIN pg_am am ON am.oid = idx.relam
		WHERE n.nspname = $1 AND t.relname = $2
		ORDER BY idx.relname`, postgresSchema(schema), table)
	if err != nil {
		return nil, fmt.Errorf("list postgres indexes: %w", err)
	}
	return indexes, nil
}

func (a *PostgresAdapter) Execute(sqlText string) (*QueryResult, error) {
	start := time.Now()
	trimmed := strings.TrimSpace(sqlText)
	if trimmed == "" {
		return &QueryResult{Error: "empty SQL"}, nil
	}
	prefix := strings.ToUpper(strings.Fields(trimmed)[0])
	if prefix == "SELECT" || prefix == "SHOW" || prefix == "WITH" ||
		prefix == "VALUES" || prefix == "TABLE" || prefix == "EXPLAIN" {
		return a.executeSelect(trimmed, nil, start)
	}
	result, err := a.db.Exec(trimmed)
	if err != nil {
		return &QueryResult{DurationMs: time.Since(start).Milliseconds(), Error: err.Error()}, nil
	}
	affected, _ := result.RowsAffected()
	return &QueryResult{
		RowsAffected: affected,
		DurationMs:   time.Since(start).Milliseconds(),
		IsSelect:     false,
	}, nil
}

func (a *PostgresAdapter) executeSelect(
	query string,
	args []interface{},
	start time.Time,
) (*QueryResult, error) {
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
	for index, column := range columnTypes {
		nullable, _ := column.Nullable()
		columns[index] = ColumnInfo{Name: column.Name(), Type: column.DatabaseTypeName(), Nullable: nullable}
	}
	data := make([][]interface{}, 0)
	for rows.Next() {
		values, scanErr := rows.SliceScan()
		if scanErr != nil {
			return nil, scanErr
		}
		for index, value := range values {
			values[index] = normalizePostgresValue(value)
		}
		data = append(data, values)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &QueryResult{
		Columns:    columns,
		Rows:       data,
		DurationMs: time.Since(start).Milliseconds(),
		IsSelect:   true,
	}, nil
}

func normalizePostgresValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case []byte:
		return string(typed)
	case time.Time:
		return typed.Format(time.RFC3339Nano)
	default:
		return value
	}
}

func (a *PostgresAdapter) Explain(sqlText string) (*QueryResult, error) {
	return a.executeSelect("EXPLAIN (FORMAT JSON) "+sqlText, nil, time.Now())
}

func (a *PostgresAdapter) GetTableDDL(schema, table string) (string, error) {
	columns, err := a.ListColumns(schema, table)
	if err != nil {
		return "", err
	}
	definitions := make([]string, 0, len(columns))
	for _, column := range columns {
		definition := "  " + quotePostgresIdentifier(column.Name) + " " + column.Type
		if column.Nullable == "NO" {
			definition += " NOT NULL"
		}
		if column.DefaultValue != nil {
			definition += " DEFAULT " + *column.DefaultValue
		}
		definitions = append(definitions, definition)
	}
	return fmt.Sprintf("CREATE TABLE %s (\n%s\n);",
		qualifiedPostgresIdentifier(schema, table),
		strings.Join(definitions, ",\n")), nil
}

func (a *PostgresAdapter) GetTableData(
	schema, table string,
	limit, offset int,
	orderBy, orderDir, filter, quickFilter string,
	columnFilters map[string]string,
) (*QueryResult, error) {
	if limit <= 0 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	args := make([]interface{}, 0)
	conditions := make([]string, 0)
	if strings.TrimSpace(filter) != "" {
		conditions = append(conditions, "("+filter+")")
	}
	keys := make([]string, 0, len(columnFilters))
	for column := range columnFilters {
		keys = append(keys, column)
	}
	sort.Strings(keys)
	for _, column := range keys {
		value := strings.TrimSpace(columnFilters[column])
		if value == "" {
			continue
		}
		args = append(args, "%"+value+"%")
		conditions = append(conditions,
			fmt.Sprintf("CAST(%s AS TEXT) ILIKE $%d", quotePostgresIdentifier(column), len(args)))
	}
	// 快捷筛选:所有列 ILIKE '%kw%'(列名来自 information_schema,参数化防注入)
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
			args = append(args, "%"+quickFilter+"%")
			likeParts = append(likeParts,
				fmt.Sprintf("CAST(%s AS TEXT) ILIKE $%d", quotePostgresIdentifier(c.Name), len(args)))
		}
		if len(likeParts) > 0 {
			conditions = append(conditions, "("+strings.Join(likeParts, " OR ")+")")
		}
	}
	query := "SELECT * FROM " + qualifiedPostgresIdentifier(schema, table)
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	if orderBy != "" {
		direction := "ASC"
		if strings.EqualFold(orderDir, "DESC") {
			direction = "DESC"
		}
		query += " ORDER BY " + quotePostgresIdentifier(orderBy) + " " + direction
	}
	query += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)
	result, err := a.executeSelect(query, args, time.Now())
	if err != nil {
		return nil, err
	}
	if len(conditions) > 0 && result.Error == "" {
		var total int64
		countQuery := "SELECT COUNT(*) FROM " + qualifiedPostgresIdentifier(schema, table) +
			" WHERE " + strings.Join(conditions, " AND ")
		if countErr := a.db.Get(&total, countQuery, args...); countErr == nil {
			result.TotalRows = total
		}
	}
	return result, nil
}

func (a *PostgresAdapter) DropTable(schema, table string, ifExists bool) error {
	clause := ""
	if ifExists {
		clause = " IF EXISTS"
	}
	_, err := a.db.Exec("DROP TABLE" + clause + " " + qualifiedPostgresIdentifier(schema, table))
	return err
}

func (a *PostgresAdapter) TruncateTable(schema, table string) error {
	_, err := a.db.Exec("TRUNCATE TABLE " + qualifiedPostgresIdentifier(schema, table))
	return err
}

func (a *PostgresAdapter) RenameTable(schema, oldName, newName string) error {
	_, err := a.db.Exec("ALTER TABLE " + qualifiedPostgresIdentifier(schema, oldName) +
		" RENAME TO " + quotePostgresIdentifier(newName))
	return err
}

func (a *PostgresAdapter) InsertRow(schema, table string, values map[string]interface{}) (int64, error) {
	if len(values) == 0 {
		return 0, fmt.Errorf("values cannot be empty")
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	columns := make([]string, len(keys))
	placeholders := make([]string, len(keys))
	args := make([]interface{}, len(keys))
	for index, key := range keys {
		columns[index] = quotePostgresIdentifier(key)
		placeholders[index] = fmt.Sprintf("$%d", index+1)
		args[index] = values[key]
	}
	result, err := a.db.Exec(
		"INSERT INTO "+qualifiedPostgresIdentifier(schema, table)+
			" ("+strings.Join(columns, ", ")+") VALUES ("+strings.Join(placeholders, ", ")+")",
		args...,
	)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (a *PostgresAdapter) UpdateRows(
	schema, table string,
	sets map[string]interface{},
	where string,
) (int64, error) {
	if len(sets) == 0 || strings.TrimSpace(where) == "" {
		return 0, fmt.Errorf("sets and where are required")
	}
	keys := make([]string, 0, len(sets))
	for key := range sets {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	assignments := make([]string, len(keys))
	args := make([]interface{}, len(keys))
	for index, key := range keys {
		assignments[index] = fmt.Sprintf("%s = $%d", quotePostgresIdentifier(key), index+1)
		args[index] = sets[key]
	}
	result, err := a.db.Exec("UPDATE "+qualifiedPostgresIdentifier(schema, table)+
		" SET "+strings.Join(assignments, ", ")+" WHERE "+where, args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (a *PostgresAdapter) DeleteRows(schema, table, where string) (int64, error) {
	if strings.TrimSpace(where) == "" {
		return 0, fmt.Errorf("where is required")
	}
	result, err := a.db.Exec("DELETE FROM " + qualifiedPostgresIdentifier(schema, table) + " WHERE " + where)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (a *PostgresAdapter) GetRowCount(schema, table string) (int64, error) {
	var count int64
	err := a.db.Get(&count, "SELECT COUNT(*) FROM "+qualifiedPostgresIdentifier(schema, table))
	return count, err
}

func (a *PostgresAdapter) GetTableMeta(schema, table string) (*TableMeta, error) {
	columns, err := a.ListColumns(schema, table)
	if err != nil {
		return nil, err
	}
	count, err := a.GetRowCount(schema, table)
	if err != nil {
		return nil, err
	}
	return &TableMeta{Columns: columns, RowCount: count}, nil
}

func (a *PostgresAdapter) CreateIndex(
	schema, table, indexName string,
	columns []string,
	unique bool,
	indexType string,
) error {
	if len(columns) == 0 {
		return fmt.Errorf("columns cannot be empty")
	}
	method := strings.ToUpper(indexType)
	if method == "" {
		method = "BTREE"
	}
	allowed := map[string]bool{"BTREE": true, "HASH": true, "GIST": true, "GIN": true, "BRIN": true}
	if !allowed[method] {
		return fmt.Errorf("unsupported postgres index type: %s", method)
	}
	quoted := make([]string, len(columns))
	for index, column := range columns {
		quoted[index] = quotePostgresIdentifier(column)
	}
	uniqueClause := ""
	if unique {
		uniqueClause = "UNIQUE "
	}
	_, err := a.db.Exec(fmt.Sprintf("CREATE %sINDEX %s ON %s USING %s (%s)",
		uniqueClause,
		quotePostgresIdentifier(indexName),
		qualifiedPostgresIdentifier(schema, table),
		method,
		strings.Join(quoted, ", ")))
	return err
}

func (a *PostgresAdapter) DropIndex(schema, _ string, indexName string) error {
	_, err := a.db.Exec("DROP INDEX " +
		quotePostgresIdentifier(postgresSchema(schema)) + "." + quotePostgresIdentifier(indexName))
	return err
}

func (a *PostgresAdapter) ExportCSV(schema, table string, limit int) (*QueryResult, error) {
	if limit <= 0 {
		limit = 100000
	}
	return a.executeSelect(fmt.Sprintf("SELECT * FROM %s LIMIT %d",
		qualifiedPostgresIdentifier(schema, table), limit), nil, time.Now())
}

func (a *PostgresAdapter) ExportJSON(schema, table string, limit int) (string, error) {
	result, err := a.ExportCSV(schema, table, limit)
	if err != nil {
		return "", err
	}
	rows := make([]map[string]interface{}, len(result.Rows))
	for rowIndex, values := range result.Rows {
		row := make(map[string]interface{}, len(result.Columns))
		for columnIndex, column := range result.Columns {
			if columnIndex < len(values) {
				row[column.Name] = values[columnIndex]
			}
		}
		rows[rowIndex] = row
	}
	data, err := json.MarshalIndent(rows, "", "  ")
	return string(data), err
}
