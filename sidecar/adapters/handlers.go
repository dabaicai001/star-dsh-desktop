package adapters

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/rs/zerolog/log"
	"github.com/starhub/sidecar/pool"
	"github.com/starhub/sidecar/rpc"
	"github.com/xuri/excelize/v2"
)

// Handler 是 RPC 处理函数（复用 rpc 包的类型）
type Handler = rpc.Handler

// RegisterDBHandlers 注册所有数据库相关 RPC 方法
func RegisterDBHandlers(server ServerInterface, mgr *pool.Manager) {
	registerBrokerHandlers(server)
	// MySQL
	server.Register("db.mysql.connect", handleMySQLConnect(mgr))
	server.Register("db.mysql.test", handleMySQLTest())
	server.Register("db.mysql.disconnect", handleDisconnect(mgr))
	server.Register("db.mysql.listDatabases", handleMySQLListDatabases(mgr))
	server.Register("db.mysql.listTables", handleMySQLListTables(mgr))
	server.Register("db.mysql.listColumns", handleMySQLListColumns(mgr))
	server.Register("db.mysql.listIndexes", handleMySQLListIndexes(mgr))
	server.Register("db.mysql.execute", handleMySQLExecute(mgr))
	server.Register("db.mysql.explain", handleMySQLExplain(mgr))
	server.Register("db.mysql.getTableDDL", handleMySQLGetTableDDL(mgr))
	server.Register("db.mysql.getTableData", handleMySQLGetTableData(mgr))
	server.Register("db.mysql.dropTable", handleMySQLDropTable(mgr))
	server.Register("db.mysql.truncateTable", handleMySQLTruncateTable(mgr))
	server.Register("db.mysql.renameTable", handleMySQLRenameTable(mgr))
	server.Register("db.mysql.insertRow", handleMySQLInsertRow(mgr))
	server.Register("db.mysql.updateRows", handleMySQLUpdateRows(mgr))
	server.Register("db.mysql.deleteRows", handleMySQLDeleteRows(mgr))
	server.Register("db.mysql.exportData", handleMySQLExportData(mgr))
	server.Register("db.mysql.exportExcel", handleMySQLExportExcel(mgr))
	server.Register("db.mysql.getRowCount", handleMySQLGetRowCount(mgr))
	server.Register("db.mysql.getTableMeta", handleMySQLGetTableMeta(mgr))
	server.Register("db.mysql.createIndex", handleMySQLCreateIndex(mgr))
	server.Register("db.mysql.dropIndex", handleMySQLDropIndex(mgr))

	// PostgreSQL 连接建立后复用上面的关系型数据库 CRUD handlers。
	server.Register("db.postgres.connect", handlePostgresConnect(mgr))
	server.Register("db.postgres.test", handlePostgresTest())
	server.Register("db.postgres.disconnect", handleDisconnect(mgr))

	// SQLite 连接建立后复用 MySQL 关系型数据库 CRUD handlers（参考 PostgreSQL 模式）
	server.Register("db.sqlite.connect", handleSQLiteConnect(mgr))
	server.Register("db.sqlite.test", handleSQLiteTest())
	server.Register("db.sqlite.disconnect", handleDisconnect(mgr))

	// SQL Server (MSSQL) 连接建立后复用 MySQL 关系型数据库 CRUD handlers
	server.Register("db.mssql.connect", handleMSSQLConnect(mgr))
	server.Register("db.mssql.test", handleMSSQLTest())
	server.Register("db.mssql.disconnect", handleDisconnect(mgr))

	// ClickHouse
	server.Register("db.clickhouse.connect", handleClickHouseConnect(mgr))
	server.Register("db.clickhouse.test", handleClickHouseTest())
	server.Register("db.clickhouse.disconnect", handleDisconnect(mgr))
	server.Register("db.clickhouse.listDatabases", handleClickHouseListDatabases(mgr))
	server.Register("db.clickhouse.listTables", handleClickHouseListTables(mgr))
	server.Register("db.clickhouse.listColumns", handleClickHouseListColumns(mgr))
	server.Register("db.clickhouse.listIndexes", handleClickHouseListIndexes(mgr))
	server.Register("db.clickhouse.execute", handleClickHouseExecute(mgr))
	server.Register("db.clickhouse.explain", handleClickHouseExplain(mgr))
	server.Register("db.clickhouse.getTableDDL", handleClickHouseGetTableDDL(mgr))
	server.Register("db.clickhouse.getTableData", handleClickHouseGetTableData(mgr))
	server.Register("db.clickhouse.dropTable", handleClickHouseDropTable(mgr))
	server.Register("db.clickhouse.truncateTable", handleClickHouseTruncateTable(mgr))
	server.Register("db.clickhouse.renameTable", handleClickHouseRenameTable(mgr))
	server.Register("db.clickhouse.insertRow", handleClickHouseInsertRow(mgr))
	server.Register("db.clickhouse.updateRows", handleClickHouseUpdateRows(mgr))
	server.Register("db.clickhouse.deleteRows", handleClickHouseDeleteRows(mgr))
	server.Register("db.clickhouse.exportData", handleClickHouseExportData(mgr))
	server.Register("db.clickhouse.exportExcel", handleClickHouseExportExcel(mgr))
	server.Register("db.clickhouse.getRowCount", handleClickHouseGetRowCount(mgr))
	server.Register("db.clickhouse.getTableMeta", handleClickHouseGetTableMeta(mgr))
	server.Register("db.clickhouse.createIndex", handleClickHouseCreateIndex(mgr))
	server.Register("db.clickhouse.dropIndex", handleClickHouseDropIndex(mgr))
	// ClickHouse 特有
	server.Register("db.clickhouse.getPartitions", handleClickHouseGetPartitions(mgr))
	server.Register("db.clickhouse.getMergeTreeInfo", handleClickHouseGetMergeTreeInfo(mgr))
	server.Register("db.clickhouse.getTableStats", handleClickHouseGetTableStats(mgr))

	// Redis
	server.Register("db.redis.connect", handleRedisConnect(mgr))
	server.Register("db.redis.test", handleRedisTest())
	server.Register("db.redis.disconnect", handleDisconnect(mgr))
	server.Register("db.redis.select", handleRedisSelect(mgr))
	server.Register("db.redis.scan", handleRedisScan(mgr))
	server.Register("db.redis.getValue", handleRedisGetValue(mgr))
	server.Register("db.redis.del", handleRedisDel(mgr))
	server.Register("db.redis.rename", handleRedisRename(mgr))
	server.Register("db.redis.set", handleRedisSet(mgr))
	server.Register("db.redis.execute", handleRedisExecute(mgr))
	server.Register("db.redis.info", handleRedisInfo(mgr))
	server.Register("db.redis.dbSize", handleRedisDBSize(mgr))
	server.Register("db.redis.slowlogGet", handleRedisSlowlogGet(mgr))
	server.Register("db.redis.slowlogReset", handleRedisSlowlogReset(mgr))
	server.Register("db.redis.scanAll", handleRedisScanAll(mgr))
	server.Register("db.redis.bigkeyScan", handleRedisBigKeyScan(mgr))
	server.Register("db.redis.memoryAnalysis", handleRedisMemoryAnalysis(mgr))
	server.Register("db.redis.flushDb", handleRedisFlushDB(mgr))
	server.Register("db.redis.subscribe", handleRedisSubscribe(mgr))
	server.Register("db.redis.unsubscribe", handleRedisUnsubscribe(mgr))

	// Elasticsearch
	server.Register("db.es.connect", handleESConnect(mgr))
	server.Register("db.es.test", handleESTest())
	server.Register("db.es.disconnect", handleDisconnect(mgr))
	server.Register("db.es.clusterHealth", handleESClusterHealth(mgr))
	server.Register("db.es.clusterStats", handleESClusterStats(mgr))
	server.Register("db.es.listIndices", handleESListIndices(mgr))
	server.Register("db.es.getIndexMapping", handleESGetMapping(mgr))
	server.Register("db.es.getIndexSettings", handleESGetSettings(mgr))
	server.Register("db.es.createIndex", handleESCreateIndex(mgr))
	server.Register("db.es.deleteIndex", handleESDeleteIndex(mgr))
	server.Register("db.es.search", handleESSearch(mgr))
	server.Register("db.es.count", handleESCount(mgr))
	server.Register("db.es.getDocument", handleESGetDocument(mgr))
	server.Register("db.es.indexDocument", handleESIndexDocument(mgr))
	server.Register("db.es.updateDocument", handleESUpdateDocument(mgr))
	server.Register("db.es.deleteDocument", handleESDeleteDocument(mgr))
	server.Register("db.es.bulkIndex", handleESBulkIndex(mgr))
	server.Register("db.es.exportJSON", handleESExportJSON(mgr))
	server.Register("db.es.scrollSearch", handleESScrollSearch(mgr))

	// Backup / Restore
	server.Register("db.backup", handleBackupDatabase(mgr))
	server.Register("db.restore", handleRestoreDatabase(mgr))
	server.Register("db.listBackups", handleListBackups(mgr))
}

// ServerInterface 定义 server 需要的方法（避免循环导入）
type ServerInterface interface {
	Register(method string, handler rpc.Handler)
}

// ─── MySQL Handlers ───

func handleMySQLConnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info MySQLConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		adapter, err := NewMySQLAdapter(&info)
		if err != nil {
			return nil, err
		}

		connID := fmt.Sprintf("mysql_%s_%d_%d", info.Host, info.Port, time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{
			ID:       connID,
			Type:     pool.ConnMySQL,
			Host:     info.Host,
			Port:     info.Port,
			Database: info.Database,
		})

		return map[string]interface{}{
			"connId":   connID,
			"host":     info.Host,
			"port":     info.Port,
			"database": info.Database,
		}, nil
	}
}

func handleMySQLTest() Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info MySQLConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		start := time.Now()
		adapter, err := NewMySQLAdapter(&info)
		if err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}
		defer adapter.Close()

		if err := adapter.Ping(); err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}

		elapsed := time.Since(start).Milliseconds()
		return map[string]interface{}{
			"ok":         true,
			"message":    fmt.Sprintf("OK in %dms (%s@%s:%d)", elapsed, info.Username, info.Host, info.Port),
			"elapsed_ms": elapsed,
		}, nil
	}
}

func handleDisconnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		return nil, mgr.Remove(p.ConnID)
	}
}

type relationalAdapter interface {
	pool.DBAdapter
	DefaultNamespace() string
	ScopeSQL(string, string) string
	ListDatabases() ([]string, error)
	ListTables(string) ([]TableInfo, error)
	ListColumns(string, string) ([]ColumnMeta, error)
	ListIndexes(string, string) ([]IndexInfo, error)
	CreateIndex(string, string, string, []string, bool, string) error
	DropIndex(string, string, string) error
	Execute(string) (*QueryResult, error)
	Explain(string) (*QueryResult, error)
	GetTableDDL(string, string) (string, error)
	GetTableData(string, string, int, int, string, string, string, string, map[string]string) (*QueryResult, error)
	DropTable(string, string, bool) error
	TruncateTable(string, string) error
	RenameTable(string, string, string) error
	InsertRow(string, string, map[string]interface{}) (int64, error)
	UpdateRows(string, string, map[string]interface{}, string) (int64, error)
	DeleteRows(string, string, string) (int64, error)
	ExportCSV(string, string, int) (*QueryResult, error)
	ExportJSON(string, string, int) (string, error)
	GetRowCount(string, string) (int64, error)
	GetTableMeta(string, string) (*TableMeta, error)
}

func getRelationalAdapter(mgr *pool.Manager, connID string) (relationalAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnMySQL && info.Type != pool.ConnPG &&
		info.Type != pool.ConnSQLite && info.Type != pool.ConnMSSQL {
		return nil, fmt.Errorf("connection %s is not relational SQL (type=%s)", connID, info.Type)
	}
	relational, ok := adapter.(relationalAdapter)
	if !ok {
		return nil, fmt.Errorf("connection %s does not implement relational operations", connID)
	}
	return relational, nil
}

func getSQLiteAdapter(mgr *pool.Manager, connID string) (*SQLiteAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnSQLite {
		return nil, fmt.Errorf("connection %s is not SQLite (type=%s)", connID, info.Type)
	}
	return adapter.(*SQLiteAdapter), nil
}

func getMSSQLAdapter(mgr *pool.Manager, connID string) (*MSSQLAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnMSSQL {
		return nil, fmt.Errorf("connection %s is not MSSQL (type=%s)", connID, info.Type)
	}
	return adapter.(*MSSQLAdapter), nil
}

func getClickHouseAdapter(mgr *pool.Manager, connID string) (*ClickHouseAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnCH {
		return nil, fmt.Errorf("connection %s is not ClickHouse (type=%s)", connID, info.Type)
	}
	return adapter.(*ClickHouseAdapter), nil
}

func handleMySQLListDatabases(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListDatabases()
	}
}

func handleMySQLListTables(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListTables(p.Database)
	}
}

func handleMySQLListColumns(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListColumns(p.Database, p.Table)
	}
}

func handleMySQLListIndexes(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListIndexes(p.Database, p.Table)
	}
}

func handleMySQLCreateIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string   `json:"connId"`
			Database  string   `json:"database,omitempty"`
			Table     string   `json:"table"`
			IndexName string   `json:"indexName"`
			Columns   []string `json:"columns"`
			Unique    bool     `json:"unique"`
			IndexType string   `json:"indexType"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.CreateIndex(p.Database, p.Table, p.IndexName, p.Columns, p.Unique, p.IndexType)
	}
}

func handleMySQLDropIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			Database  string `json:"database,omitempty"`
			Table     string `json:"table"`
			IndexName string `json:"indexName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.DropIndex(p.Database, p.Table, p.IndexName)
	}
}

func handleMySQLExecute(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			SQL      string `json:"sql"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		sql := p.SQL
		dbName := p.Database
		if dbName == "" {
			dbName = adapter.DefaultNamespace()
		}
		sql = adapter.ScopeSQL(sql, dbName)
		return adapter.Execute(sql)
	}
}

func handleMySQLExplain(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			SQL      string `json:"sql"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		sql := p.SQL
		dbName := p.Database
		if dbName == "" {
			dbName = adapter.DefaultNamespace()
		}
		sql = adapter.ScopeSQL(sql, dbName)
		return adapter.Explain(sql)
	}
}

func handleMySQLGetTableDDL(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		ddl, err := adapter.GetTableDDL(p.Database, p.Table)
		if err != nil {
			return nil, err
		}
		return map[string]string{"ddl": ddl}, nil
	}
}

func handleMySQLGetTableData(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID        string            `json:"connId"`
			Database      string            `json:"database,omitempty"`
			Table         string            `json:"table"`
			Limit         int               `json:"limit,omitempty"`
			Offset        int               `json:"offset,omitempty"`
			OrderBy       string            `json:"orderBy,omitempty"`
			OrderDir      string            `json:"orderDir,omitempty"`
			Filter        string            `json:"filter,omitempty"`
			QuickFilter   string            `json:"quickFilter,omitempty"`
			ColumnFilters map[string]string `json:"columnFilters,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		log.Info().Str("filter", p.Filter).Str("quickFilter", p.QuickFilter).Interface("columnFilters", p.ColumnFilters).Msg("handleMySQLGetTableData")
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetTableData(p.Database, p.Table, p.Limit, p.Offset, p.OrderBy, p.OrderDir, p.Filter, p.QuickFilter, p.ColumnFilters)
	}
}

func handleMySQLDropTable(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
			IfExists bool   `json:"ifExists,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.DropTable(p.Database, p.Table, p.IfExists)
	}
}

func handleMySQLTruncateTable(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.TruncateTable(p.Database, p.Table)
	}
}

func handleMySQLRenameTable(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			OldName  string `json:"oldName"`
			NewName  string `json:"newName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.RenameTable(p.Database, p.OldName, p.NewName)
	}
}

func handleMySQLInsertRow(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string                 `json:"connId"`
			Database string                 `json:"database,omitempty"`
			Table    string                 `json:"table"`
			Values   map[string]interface{} `json:"values"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		id, err := adapter.InsertRow(p.Database, p.Table, p.Values)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"lastInsertId": id}, nil
	}
}

func handleMySQLUpdateRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string                 `json:"connId"`
			Database string                 `json:"database,omitempty"`
			Table    string                 `json:"table"`
			Sets     map[string]interface{} `json:"sets"`
			Where    string                 `json:"where"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		affected, err := adapter.UpdateRows(p.Database, p.Table, p.Sets, p.Where)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"rowsAffected": affected}, nil
	}
}

func handleMySQLDeleteRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
			Where    string `json:"where"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		affected, err := adapter.DeleteRows(p.Database, p.Table, p.Where)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"rowsAffected": affected}, nil
	}
}

func handleMySQLExportData(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
			Format   string `json:"format"` // csv, json, sql
			Limit    int    `json:"limit,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}

		switch p.Format {
		case "json":
			data, err := adapter.ExportJSON(p.Database, p.Table, p.Limit)
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"data": data, "format": "json"}, nil
		default: // csv
			result, err := adapter.ExportCSV(p.Database, p.Table, p.Limit)
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"result": result, "format": "csv"}, nil
		}
	}
}

func handleMySQLExportExcel(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID        string            `json:"connId"`
			Database      string            `json:"database,omitempty"`
			Table         string            `json:"table"`
			FilePath      string            `json:"filePath"`
			Filter        string            `json:"filter,omitempty"`
			ColumnFilters map[string]string `json:"columnFilters,omitempty"`
			OrderBy       string            `json:"orderBy,omitempty"`
			OrderDir      string            `json:"orderDir,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.Table == "" || p.FilePath == "" {
			return nil, fmt.Errorf("table and filePath are required")
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		mysqlAdapter, ok := adapter.(*MySQLAdapter)
		if !ok {
			return nil, fmt.Errorf("connection %s is not a MySQL connection", p.ConnID)
		}
		start := time.Now()
		totalRows, err := mysqlAdapter.ExportExcel(p.Database, p.Table, p.FilePath, p.Filter, p.ColumnFilters, p.OrderBy, p.OrderDir)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"filePath":   p.FilePath,
			"totalRows":  totalRows,
			"durationMs": time.Since(start).Milliseconds(),
		}, nil
	}
}

func handleMySQLGetRowCount(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		count, err := adapter.GetRowCount(p.Database, p.Table)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"count": count}, nil
	}
}

func handleMySQLGetTableMeta(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRelationalAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetTableMeta(p.Database, p.Table)
	}
}

// ─── ClickHouse Handlers ───

func handleClickHouseConnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info ClickHouseConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		adapter, err := NewClickHouseAdapter(&info)
		if err != nil {
			return nil, err
		}

		connID := fmt.Sprintf("clickhouse_%s_%d_%d", info.Host, info.Port, time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{
			ID:       connID,
			Type:     pool.ConnCH,
			Host:     info.Host,
			Port:     info.Port,
			Database: info.Database,
		})

		return map[string]interface{}{
			"connId":   connID,
			"host":     info.Host,
			"port":     info.Port,
			"database": info.Database,
		}, nil
	}
}

func handleClickHouseTest() Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info ClickHouseConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		start := time.Now()
		adapter, err := NewClickHouseAdapter(&info)
		if err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}
		defer adapter.Close()

		if err := adapter.Ping(); err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}

		elapsed := time.Since(start).Milliseconds()
		return map[string]interface{}{
			"ok":         true,
			"message":    fmt.Sprintf("OK in %dms (%s@%s:%d)", elapsed, info.Username, info.Host, info.Port),
			"elapsed_ms": elapsed,
		}, nil
	}
}

func handleClickHouseListDatabases(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListDatabases()
	}
}

func handleClickHouseListTables(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListTables(p.Database)
	}
}

func handleClickHouseListColumns(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListColumns(p.Database, p.Table)
	}
}

func handleClickHouseListIndexes(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListIndexes(p.Database, p.Table)
	}
}

func handleClickHouseCreateIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string   `json:"connId"`
			Database  string   `json:"database,omitempty"`
			Table     string   `json:"table"`
			IndexName string   `json:"indexName"`
			Columns   []string `json:"columns"`
			Unique    bool     `json:"unique"`
			IndexType string   `json:"indexType"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.CreateIndex(p.Database, p.Table, p.IndexName, p.Columns, p.Unique, p.IndexType)
	}
}

func handleClickHouseDropIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			Database  string `json:"database,omitempty"`
			Table     string `json:"table"`
			IndexName string `json:"indexName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.DropIndex(p.Database, p.Table, p.IndexName)
	}
}

func handleClickHouseExecute(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			SQL      string `json:"sql"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.Execute(p.SQL)
	}
}

func handleClickHouseExplain(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			SQL      string `json:"sql"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.Explain(p.SQL)
	}
}

func handleClickHouseGetTableDDL(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		ddl, err := adapter.GetTableDDL(p.Database, p.Table)
		if err != nil {
			return nil, err
		}
		return map[string]string{"ddl": ddl}, nil
	}
}

func handleClickHouseGetTableData(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID        string            `json:"connId"`
			Database      string            `json:"database,omitempty"`
			Table         string            `json:"table"`
			Limit         int               `json:"limit,omitempty"`
			Offset        int               `json:"offset,omitempty"`
			OrderBy       string            `json:"orderBy,omitempty"`
			OrderDir      string            `json:"orderDir,omitempty"`
			Filter        string            `json:"filter,omitempty"`
			QuickFilter   string            `json:"quickFilter,omitempty"`
			ColumnFilters map[string]string `json:"columnFilters,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetTableData(p.Database, p.Table, p.Limit, p.Offset, p.OrderBy, p.OrderDir, p.Filter, p.QuickFilter, p.ColumnFilters)
	}
}

func handleClickHouseDropTable(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
			IfExists bool   `json:"ifExists,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.DropTable(p.Database, p.Table, p.IfExists)
	}
}

func handleClickHouseTruncateTable(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.TruncateTable(p.Database, p.Table)
	}
}

func handleClickHouseRenameTable(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			OldName  string `json:"oldName"`
			NewName  string `json:"newName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.RenameTable(p.Database, p.OldName, p.NewName)
	}
}

func handleClickHouseInsertRow(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string                 `json:"connId"`
			Database string                 `json:"database,omitempty"`
			Table    string                 `json:"table"`
			Values   map[string]interface{} `json:"values"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		id, err := adapter.InsertRow(p.Database, p.Table, p.Values)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"lastInsertId": id}, nil
	}
}

func handleClickHouseUpdateRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string                 `json:"connId"`
			Database string                 `json:"database,omitempty"`
			Table    string                 `json:"table"`
			Sets     map[string]interface{} `json:"sets"`
			Where    string                 `json:"where"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		affected, err := adapter.UpdateRows(p.Database, p.Table, p.Sets, p.Where)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"rowsAffected": affected}, nil
	}
}

func handleClickHouseDeleteRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
			Where    string `json:"where"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		affected, err := adapter.DeleteRows(p.Database, p.Table, p.Where)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"rowsAffected": affected}, nil
	}
}

func handleClickHouseExportData(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
			Format   string `json:"format"`
			Limit    int    `json:"limit,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}

		switch p.Format {
		case "json":
			data, err := adapter.ExportJSON(p.Database, p.Table, p.Limit)
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"data": data, "format": "json"}, nil
		default:
			result, err := adapter.ExportCSV(p.Database, p.Table, p.Limit)
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"result": result, "format": "csv"}, nil
		}
	}
}

func handleClickHouseExportExcel(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID        string            `json:"connId"`
			Database      string            `json:"database,omitempty"`
			Table         string            `json:"table"`
			FilePath      string            `json:"filePath"`
			Filter        string            `json:"filter,omitempty"`
			ColumnFilters map[string]string `json:"columnFilters,omitempty"`
			OrderBy       string            `json:"orderBy,omitempty"`
			OrderDir      string            `json:"orderDir,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.Table == "" || p.FilePath == "" {
			return nil, fmt.Errorf("table and filePath are required")
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		start := time.Now()
		totalRows, err := adapter.ExportExcel(p.Database, p.Table, p.FilePath, p.Filter, p.ColumnFilters, p.OrderBy, p.OrderDir)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"filePath":   p.FilePath,
			"totalRows":  totalRows,
			"durationMs": time.Since(start).Milliseconds(),
		}, nil
	}
}

func handleClickHouseGetRowCount(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		count, err := adapter.GetRowCount(p.Database, p.Table)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"count": count}, nil
	}
}

func handleClickHouseGetTableMeta(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetTableMeta(p.Database, p.Table)
	}
}

func handleClickHouseGetPartitions(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetPartitions(p.Database, p.Table)
	}
}

func handleClickHouseGetMergeTreeInfo(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetMergeTreeInfo(p.Database, p.Table)
	}
}

func handleClickHouseGetTableStats(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getClickHouseAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetTableStats(p.Database, p.Table)
	}
}

// ─── Redis Handlers ───

func handleRedisConnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info RedisConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		adapter, err := NewRedisAdapter(&info)
		if err != nil {
			return nil, err
		}

		connID := fmt.Sprintf("redis_%s_%d_%d", info.Host, info.Port, time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{
			ID:       connID,
			Type:     pool.ConnRedis,
			Host:     info.Host,
			Port:     info.Port,
			Database: fmt.Sprintf("db%d", info.DB),
		})

		return map[string]interface{}{
			"connId": connID,
			"host":   info.Host,
			"port":   info.Port,
			"db":     info.DB,
		}, nil
	}
}

func handleRedisTest() Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info RedisConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		start := time.Now()
		adapter, err := NewRedisAdapter(&info)
		if err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}
		defer adapter.Close()

		if err := adapter.Ping(); err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}

		elapsed := time.Since(start).Milliseconds()
		return map[string]interface{}{
			"ok":         true,
			"message":    fmt.Sprintf("OK in %dms (redis@%s:%d/%d)", elapsed, info.Host, info.Port, info.DB),
			"elapsed_ms": elapsed,
		}, nil
	}
}

func getRedisAdapter(mgr *pool.Manager, connID string) (*RedisAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnRedis {
		return nil, fmt.Errorf("connection %s is not Redis (type=%s)", connID, info.Type)
	}
	return adapter.(*RedisAdapter), nil
}

func handleRedisSelect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			DB     int    `json:"db"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.Select(p.DB)
	}
}

func handleRedisScan(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Cursor uint64 `json:"cursor"`
			Match  string `json:"match,omitempty"`
			Count  int64  `json:"count,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.Scan(p.Cursor, p.Match, p.Count)
	}
}

func handleRedisGetValue(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Key    string `json:"key"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetValue(p.Key)
	}
}

func handleRedisDel(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string   `json:"connId"`
			Keys   []string `json:"keys"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		n, err := adapter.Del(p.Keys...)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"deleted": n}, nil
	}
}

func handleRedisRename(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			OldKey string `json:"oldKey"`
			NewKey string `json:"newKey"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.Rename(p.OldKey, p.NewKey)
	}
}

func handleRedisSet(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID     string `json:"connId"`
			Key        string `json:"key"`
			Value      string `json:"value"`
			Expiration int64  `json:"expiration"` // seconds, 0 = no expire
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		var exp time.Duration
		if p.Expiration > 0 {
			exp = time.Duration(p.Expiration) * time.Second
		}
		return nil, adapter.Set(p.Key, p.Value, exp)
	}
}

func handleRedisExecute(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID  string `json:"connId"`
			Command string `json:"command"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.Execute(p.Command)
	}
}

func handleRedisInfo(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID  string `json:"connId"`
			Section string `json:"section,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.RedisInfo(p.Section)
	}
}

func handleRedisDBSize(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		size, err := adapter.DBSize()
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"size": size}, nil
	}
}

func handleRedisSlowlogGet(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Count  int64  `json:"count"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.Count <= 0 {
			p.Count = 50
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.SlowlogGet(p.Count)
	}
}

func handleRedisSlowlogReset(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.SlowlogReset()
	}
}

func handleRedisScanAll(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID     string `json:"connId"`
			Match      string `json:"match,omitempty"`
			Count      int64  `json:"count,omitempty"`
			TypeFilter string `json:"typeFilter,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		keys, err := adapter.ScanAll(p.Match, p.Count, p.TypeFilter)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"keys": keys, "cursor": 0, "total": len(keys)}, nil
	}
}

func handleRedisBigKeyScan(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID          string `json:"connId"`
			Match           string `json:"match,omitempty"`
			StringThreshold int64  `json:"stringThreshold,omitempty"`
			MemberThreshold int64  `json:"memberThreshold,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.StringThreshold <= 0 {
			p.StringThreshold = 10240
		}
		if p.MemberThreshold <= 0 {
			p.MemberThreshold = 1000
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.BigKeyScan(p.Match, p.StringThreshold, p.MemberThreshold)
	}
}

func handleRedisMemoryAnalysis(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID     string `json:"connId"`
			Match      string `json:"match,omitempty"`
			SampleSize int    `json:"sampleSize,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.MemoryAnalysis(p.Match, p.SampleSize)
	}
}

func handleRedisFlushDB(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.FlushDB()
	}
}

// ─── Docker Handlers ───

// RegisterDockerHandlers 注册所有 Docker 相关 RPC 方法
func RegisterDockerHandlers(server ServerInterface, mgr *pool.Manager) {
	server.Register("docker.connect", handleDockerConnect(mgr))
	server.Register("docker.test", handleDockerTest())
	server.Register("docker.disconnect", handleDisconnect(mgr))
	server.Register("docker.listContainers", handleDockerListContainers(mgr))
	server.Register("docker.inspectContainer", handleDockerInspectContainer(mgr))
	server.Register("docker.startContainer", handleDockerStartContainer(mgr))
	server.Register("docker.stopContainer", handleDockerStopContainer(mgr))
	server.Register("docker.restartContainer", handleDockerRestartContainer(mgr))
	server.Register("docker.removeContainer", handleDockerRemoveContainer(mgr))
	server.Register("docker.containerLogs", handleDockerContainerLogs(mgr))
	server.Register("docker.containerStats", handleDockerContainerStats(mgr))
	server.Register("docker.listImages", handleDockerListImages(mgr))
	server.Register("docker.pullImage", handleDockerPullImage(mgr))
	server.Register("docker.removeImage", handleDockerRemoveImage(mgr))
	server.Register("docker.pruneImages", handleDockerPruneImages(mgr))
	server.Register("docker.exec", handleDockerExec(mgr))
	server.Register("docker.execSessionStart", handleDockerExecSessionStart(mgr))
	server.Register("docker.execSessionRead", handleDockerExecSessionRead(mgr))
	server.Register("docker.execSessionWrite", handleDockerExecSessionWrite(mgr))
	server.Register("docker.execSessionResize", handleDockerExecSessionResize(mgr))
	server.Register("docker.execSessionClose", handleDockerExecSessionClose(mgr))

	// Docker Compose
	server.Register("docker.compose.up", handleDockerComposeUp(mgr))
	server.Register("docker.compose.down", handleDockerComposeDown(mgr))
	server.Register("docker.compose.ps", handleDockerComposePs(mgr))
	server.Register("docker.compose.logs", handleDockerComposeLogs(mgr))
	server.Register("docker.compose.config", handleDockerComposeConfig(mgr))
	server.Register("docker.compose.list", handleDockerComposeList(mgr))
}

func getDockerAdapter(mgr *pool.Manager, connID string) (*DockerAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnDocker {
		return nil, fmt.Errorf("connection %s is not Docker (type=%s)", connID, info.Type)
	}
	return adapter.(*DockerAdapter), nil
}

func handleDockerConnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info DockerConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		adapter, err := NewDockerAdapter(&info)
		if err != nil {
			return nil, err
		}

		connID := fmt.Sprintf("docker_%d", time.Now().UnixNano())
		displayHost := info.Host
		if info.Transport == "ssh" && info.SSH != nil {
			displayHost = fmt.Sprintf(
				"ssh://%s@%s:%d%s",
				info.SSH.Username,
				info.SSH.Host,
				info.SSH.Port,
				info.SocketPath,
			)
		}
		mgr.Register(connID, adapter, pool.ConnInfo{
			ID:   connID,
			Type: pool.ConnDocker,
			Host: displayHost,
		})

		return map[string]interface{}{
			"connId": connID,
			"host":   displayHost,
		}, nil
	}
}

func handleDockerTest() Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info DockerConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		start := time.Now()
		adapter, err := NewDockerAdapter(&info)
		if err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}
		defer adapter.Close()

		elapsed := time.Since(start).Milliseconds()
		return map[string]interface{}{
			"ok":         true,
			"message":    fmt.Sprintf("OK in %dms", elapsed),
			"elapsed_ms": elapsed,
		}, nil
	}
}

func handleDockerListContainers(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			All    bool   `json:"all,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListContainers(p.All)
	}
}

func handleDockerInspectContainer(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.InspectContainer(p.ContainerID)
	}
}

func handleDockerStartContainer(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.StartContainer(p.ContainerID)
	}
}

func handleDockerStopContainer(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
			Timeout     *int   `json:"timeout,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.StopContainer(p.ContainerID, p.Timeout)
	}
}

func handleDockerRestartContainer(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
			Timeout     *int   `json:"timeout,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.RestartContainer(p.ContainerID, p.Timeout)
	}
}

func handleDockerRemoveContainer(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
			Force       bool   `json:"force,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.RemoveContainer(p.ContainerID, p.Force)
	}
}

func handleDockerContainerLogs(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
			Tail        string `json:"tail,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ContainerLogs(p.ContainerID, p.Tail, false)
	}
}

func handleDockerContainerStats(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ContainerStats(p.ContainerID)
	}
}

func handleDockerListImages(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			All    bool   `json:"all,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListImages(p.All)
	}
}

func handleDockerPullImage(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			ImageName string `json:"imageName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		result, err := adapter.PullImage(p.ImageName)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"result": result}, nil
	}
}

func handleDockerRemoveImage(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID  string `json:"connId"`
			ImageID string `json:"imageId"`
			Force   bool   `json:"force,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.RemoveImage(p.ImageID, p.Force)
	}
}

func handleDockerPruneImages(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.PruneImages()
	}
}

func handleDockerExec(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string   `json:"connId"`
			ContainerID string   `json:"containerId"`
			Command     []string `json:"command"`
			Workdir     string   `json:"workdir,omitempty"`
			TimeoutSec  int      `json:"timeoutSec,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.ContainerID == "" || len(p.Command) == 0 {
			return nil, fmt.Errorf("containerId and command are required")
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.Exec(p.ContainerID, p.Command, p.Workdir, p.TimeoutSec)
	}
}

func handleDockerExecSessionStart(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
			Cols        int    `json:"cols,omitempty"`
			Rows        int    `json:"rows,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.StartExecSession(p.ContainerID, p.Cols, p.Rows)
	}
}

func handleDockerExecSessionRead(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SessionID string `json:"sessionId"`
			WaitMs    int    `json:"waitMs,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if p.WaitMs <= 0 {
			p.WaitMs = 1000
		}
		return adapter.ReadExecSession(p.SessionID, time.Duration(p.WaitMs)*time.Millisecond)
	}
}

func handleDockerExecSessionWrite(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SessionID string `json:"sessionId"`
			Data      string `json:"data"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.WriteExecSession(p.SessionID, p.Data)
	}
}

func handleDockerExecSessionResize(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SessionID string `json:"sessionId"`
			Cols      int    `json:"cols"`
			Rows      int    `json:"rows"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.ResizeExecSession(p.SessionID, p.Cols, p.Rows)
	}
}

func handleDockerExecSessionClose(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SessionID string `json:"sessionId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.CloseExecSession(p.SessionID)
	}
}

// ─── Elasticsearch Handlers ───

func getESAdapter(mgr *pool.Manager, connID string) (*ElasticsearchAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnES {
		return nil, fmt.Errorf("connection %s is not Elasticsearch (type=%s)", connID, info.Type)
	}
	return adapter.(*ElasticsearchAdapter), nil
}

func handleESConnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info ElasticsearchConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		adapter, err := NewElasticsearchAdapter(&info)
		if err != nil {
			return nil, err
		}
		connID := fmt.Sprintf("es_%s_%d_%d", info.Host, info.Port, time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{
			ID:   connID,
			Type: pool.ConnES,
			Host: info.Host,
			Port: info.Port,
		})
		return map[string]interface{}{
			"connId":      connID,
			"host":        info.Host,
			"port":        info.Port,
			"clusterName": adapter.clusterName,
			"version":     adapter.version,
		}, nil
	}
}

func handleESTest() Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info ElasticsearchConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		start := time.Now()
		adapter, err := NewElasticsearchAdapter(&info)
		if err != nil {
			return map[string]interface{}{"ok": false, "message": err.Error()}, nil
		}
		defer adapter.Close()
		if err := adapter.Ping(); err != nil {
			return map[string]interface{}{"ok": false, "message": err.Error()}, nil
		}
		elapsed := time.Since(start).Milliseconds()
		return map[string]interface{}{
			"ok":         true,
			"message":    fmt.Sprintf("OK in %dms (es@%s:%d)", elapsed, info.Host, info.Port),
			"elapsed_ms": elapsed,
		}, nil
	}
}

func handleESClusterHealth(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ClusterHealth()
	}
}

func handleESClusterStats(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ClusterStats()
	}
}

func handleESListIndices(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListIndices()
	}
}

func handleESGetMapping(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Index  string `json:"index"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetMapping(p.Index)
	}
}

func handleESGetSettings(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Index  string `json:"index"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetSettings(p.Index)
	}
}

func handleESCreateIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string                 `json:"connId"`
			Index    string                 `json:"index"`
			Mappings map[string]interface{} `json:"mappings,omitempty"`
			Settings map[string]interface{} `json:"settings,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.CreateIndex(p.Index, p.Mappings, p.Settings)
	}
}

func handleESDeleteIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Index  string `json:"index"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.DeleteIndex(p.Index)
	}
}

func handleESSearch(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			Body   map[string]interface{} `json:"body"`
			From   int                    `json:"from,omitempty"`
			Size   int                    `json:"size,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.Size <= 0 {
			p.Size = 20
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.Search(p.Index, p.Body, p.From, p.Size)
	}
}

func handleESCount(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			Body   map[string]interface{} `json:"body,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		count, err := adapter.Count(p.Index, p.Body)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"count": count}, nil
	}
}

func handleESGetDocument(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Index  string `json:"index"`
			ID     string `json:"id"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetDocument(p.Index, p.ID)
	}
}

func handleESIndexDocument(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			ID     string                 `json:"id,omitempty"`
			Body   map[string]interface{} `json:"body"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.IndexDocument(p.Index, p.ID, p.Body)
	}
}

func handleESUpdateDocument(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			ID     string                 `json:"id"`
			Body   map[string]interface{} `json:"body"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.UpdateDocument(p.Index, p.ID, p.Body)
	}
}

func handleESDeleteDocument(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Index  string `json:"index"`
			ID     string `json:"id"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.DeleteDocument(p.Index, p.ID)
	}
}

func handleESBulkIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string                   `json:"connId"`
			Index     string                   `json:"index"`
			Documents []map[string]interface{} `json:"documents"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.BulkIndex(p.Index, p.Documents)
	}
}

func handleESExportJSON(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			Body   map[string]interface{} `json:"body,omitempty"`
			Size   int                    `json:"size,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.Size <= 0 {
			p.Size = 1000
		}
		if p.Body == nil {
			p.Body = map[string]interface{}{"query": map[string]interface{}{"match_all": map[string]interface{}{}}}
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		docs, err := adapter.ExportDocuments(p.Index, p.Body, p.Size)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"documents": docs, "count": len(docs)}, nil
	}
}

func handleESScrollSearch(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			Body   map[string]interface{} `json:"body"`
			Size   int                    `json:"size,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.Size <= 0 {
			p.Size = 100
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ScrollSearch(p.Index, p.Body, p.Size)
	}
}

// ====== Excel Handlers ======

// RegisterExcelHandlers 注册 Excel 文件相关 RPC 方法
func RegisterExcelHandlers(server ServerInterface, mgr *pool.Manager) {
	server.Register("file.excel.open", handleExcelOpen(mgr))
	server.Register("file.excel.create", handleExcelCreate(mgr))
	server.Register("file.excel.close", handleDisconnect(mgr))
	server.Register("file.excel.getSheetNames", handleExcelGetSheetNames(mgr))
	server.Register("file.excel.readSheet", handleExcelReadSheet(mgr))
	server.Register("file.excel.writeCells", handleExcelWriteCells(mgr))
	server.Register("file.excel.writeHeaders", handleExcelWriteHeaders(mgr))
	server.Register("file.excel.styleHeader", handleExcelStyleHeader(mgr))
	server.Register("file.excel.addSheet", handleExcelAddSheet(mgr))
	server.Register("file.excel.removeSheet", handleExcelRemoveSheet(mgr))
	server.Register("file.excel.renameSheet", handleExcelRenameSheet(mgr))
	server.Register("file.excel.save", handleExcelSave(mgr))
	server.Register("file.excel.saveAs", handleExcelSaveAs(mgr))
	server.Register("file.excel.removeDuplicates", handleExcelRemoveDuplicates(mgr))
	server.Register("file.excel.insertRows", handleExcelInsertRows(mgr))
	server.Register("file.excel.deleteRows", handleExcelDeleteRows(mgr))
	server.Register("file.excel.insertCols", handleExcelInsertCols(mgr))
	server.Register("file.excel.deleteCols", handleExcelDeleteCols(mgr))
	server.Register("file.excel.sortRows", handleExcelSortRows(mgr))
	server.Register("file.excel.findReplace", handleExcelFindReplace(mgr))
	server.Register("file.excel.freezePanes", handleExcelFreezePanes(mgr))
	server.Register("file.excel.autoFilter", handleExcelAutoFilter(mgr))
	server.Register("file.excel.createFromData", handleExcelCreateFromData(mgr))
}

// RegisterCSVHandlers 注册 CSV 文件相关 RPC 方法
func RegisterCSVHandlers(server ServerInterface, mgr *pool.Manager) {
	server.Register("file.csv.open", handleCsvOpen(mgr))
	server.Register("file.csv.close", handleDisconnect(mgr))
	server.Register("file.csv.getSheetNames", handleCsvGetSheetNames(mgr))
	server.Register("file.csv.readSheet", handleCsvReadSheet(mgr))
	server.Register("file.csv.writeCells", handleCsvWriteCells(mgr))
	server.Register("file.csv.writeHeaders", handleCsvWriteHeaders(mgr))
	server.Register("file.csv.styleHeader", handleCsvNoop(mgr))
	server.Register("file.csv.save", handleCsvSave(mgr))
	server.Register("file.csv.insertRows", handleCsvInsertRows(mgr))
	server.Register("file.csv.deleteRows", handleCsvDeleteRows(mgr))
	server.Register("file.csv.insertCols", handleCsvInsertCols(mgr))
	server.Register("file.csv.deleteCols", handleCsvDeleteCols(mgr))
	server.Register("file.csv.sortRows", handleCsvSortRows(mgr))
	server.Register("file.csv.findReplace", handleCsvFindReplace(mgr))
	server.Register("file.csv.removeDuplicates", handleCsvRemoveDuplicates(mgr))
	server.Register("file.csv.freezePanes", handleCsvNoop(mgr))
	server.Register("file.csv.autoFilter", handleCsvNoop(mgr))
}

func getExcelAdapter(mgr *pool.Manager, connID string) (*ExcelAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnExcel {
		return nil, fmt.Errorf("connection %s is not excel type (got %s)", connID, info.Type)
	}
	excelAdapter, ok := adapter.(*ExcelAdapter)
	if !ok {
		return nil, fmt.Errorf("adapter type assertion failed for %s", connID)
	}
	return excelAdapter, nil
}

func getCSVAdapter(mgr *pool.Manager, connID string) (*CsvAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnCSV {
		return nil, fmt.Errorf("connection %s is not csv type (got %s)", connID, info.Type)
	}
	csvAdapter, ok := adapter.(*CsvAdapter)
	if !ok {
		return nil, fmt.Errorf("adapter type assertion failed for %s", connID)
	}
	return csvAdapter, nil
}

func handleExcelOpen(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p ExcelConnInfo
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := NewExcelAdapter(&p)
		if err != nil {
			return nil, err
		}
		connID := fmt.Sprintf("excel_%d", time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{ID: connID, Type: pool.ConnExcel})

		sheets := adapter.GetSheetNames()
		result := map[string]interface{}{
			"connId":     connID,
			"filePath":   adapter.GetFilePath(),
			"sheetNames": sheets,
		}

		workbookSheets, err := adapter.ReadWorkbook()
		if err != nil {
			if removeErr := mgr.Remove(connID); removeErr != nil {
				return nil, fmt.Errorf("load workbook: %w; remove adapter: %v", err, removeErr)
			}
			return nil, fmt.Errorf("load workbook: %w", err)
		}
		result["sheetsData"] = workbookSheets
		if len(workbookSheets) > 0 {
			result["initialData"] = workbookSheets[0]
		}

		return result, nil
	}
}

func handleExcelCreate(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			FilePath  string `json:"filePath"`
			SheetName string `json:"sheetName,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := NewExcelAdapter(&ExcelConnInfo{FilePath: p.FilePath})
		if err != nil {
			return nil, err
		}

		// 设置默认 Sheet 名称
		sheetName := p.SheetName
		if sheetName == "" {
			sheetName = "Sheet1"
		}
		// 重命名默认的 Sheet1
		if err := adapter.f.SetSheetName("Sheet1", sheetName); err != nil {
			_ = err
		}

		connID := fmt.Sprintf("excel_%d", time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{ID: connID, Type: pool.ConnExcel})

		return map[string]interface{}{
			"connId":   connID,
			"filePath": adapter.GetFilePath(),
		}, nil
	}
}

func handleExcelGetSheetNames(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"sheetNames": adapter.GetSheetNames(),
		}, nil
	}
}

func handleExcelReadSheet(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
			Offset    int    `json:"offset,omitempty"`
			Limit     int    `json:"limit,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ReadSheet(p.SheetName, p.Offset, p.Limit)
	}
}

func handleExcelWriteCells(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string       `json:"connId"`
			SheetName string       `json:"sheetName"`
			Cells     []CellChange `json:"cells"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.WriteCells(p.SheetName, p.Cells); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelWriteHeaders(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string   `json:"connId"`
			SheetName string   `json:"sheetName"`
			Headers   []string `json:"headers"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.WriteHeaders(p.SheetName, p.Headers); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelStyleHeader(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.StyleHeader(p.SheetName); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelAddSheet(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.AddSheet(p.SheetName); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelRemoveSheet(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.RemoveSheet(p.SheetName); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelRenameSheet(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID  string `json:"connId"`
			OldName string `json:"oldName"`
			NewName string `json:"newName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.RenameSheet(p.OldName, p.NewName); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelSave(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.Save(); err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"ok":       true,
			"filePath": adapter.GetFilePath(),
		}, nil
	}
}

func handleExcelSaveAs(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			FilePath string `json:"filePath"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.SaveAs(p.FilePath); err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"ok":       true,
			"filePath": adapter.GetFilePath(),
		}, nil
	}
}

func handleExcelRemoveDuplicates(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
			Columns   []int  `json:"columns"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		removed, err := adapter.RemoveDuplicates(p.SheetName, p.Columns)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"removed": removed,
			"ok":      true,
		}, nil
	}
}

func handleExcelInsertRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
			Row       int    `json:"row"`
			Count     int    `json:"count,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.InsertRows(p.SheetName, p.Row, p.Count); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelDeleteRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
			Row       int    `json:"row"`
			Count     int    `json:"count,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.DeleteRows(p.SheetName, p.Row, p.Count); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelInsertCols(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
			Col       int    `json:"col"`
			Count     int    `json:"count,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.InsertCols(p.SheetName, p.Col, p.Count); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelDeleteCols(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
			Col       int    `json:"col"`
			Count     int    `json:"count,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.DeleteCols(p.SheetName, p.Col, p.Count); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelSortRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID     string `json:"connId"`
			SheetName  string `json:"sheetName"`
			Col        int    `json:"col"`
			Descending bool   `json:"descending,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.SortRows(p.SheetName, p.Col, p.Descending); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelFindReplace(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string             `json:"connId"`
			SheetName string             `json:"sheetName"`
			Options   FindReplaceOptions `json:"options"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		replaced, err := adapter.FindReplace(p.SheetName, p.Options)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"ok":       true,
			"replaced": replaced,
		}, nil
	}
}

func handleExcelFreezePanes(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
			Rows      int    `json:"rows"`
			Cols      int    `json:"cols"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.SetFreezePanes(p.SheetName, p.Rows, p.Cols); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelAutoFilter(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getExcelAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.SetAutoFilter(p.SheetName); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleExcelCreateFromData(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			FilePath  string     `json:"filePath"`
			SheetName string     `json:"sheetName,omitempty"`
			Columns   []string   `json:"columns"`
			Rows      [][]string `json:"rows"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := NewExcelAdapter(&ExcelConnInfo{FilePath: ""})
		if err != nil {
			return nil, err
		}

		sheetName := p.SheetName
		if sheetName == "" {
			sheetName = "Sheet1"
		}

		index, err := adapter.f.GetSheetIndex("Sheet1")
		if err == nil && index >= 0 {
			adapter.f.SetSheetName("Sheet1", sheetName)
		} else {
			adapter.f.NewSheet(sheetName)
		}

		// 写入表头
		for ci, col := range p.Columns {
			axis, _ := excelize.CoordinatesToCellName(ci+1, 1)
			adapter.f.SetCellValue(sheetName, axis, col)
		}

		// 写入数据行
		for ri, row := range p.Rows {
			for ci, val := range row {
				axis, _ := excelize.CoordinatesToCellName(ci+1, ri+2)
				adapter.f.SetCellValue(sheetName, axis, val)
			}
		}

		adapter.filePath = p.FilePath
		if p.FilePath != "" {
			if err := adapter.Save(); err != nil {
				return nil, err
			}
		}

		connID := fmt.Sprintf("excel_%d", time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{ID: connID, Type: pool.ConnExcel})

		return map[string]interface{}{
			"connId":   connID,
			"filePath": adapter.GetFilePath(),
		}, nil
	}
}

// ====== CSV Handlers ======

func handleCsvOpen(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p CsvConnInfo
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := NewCsvAdapter(&p)
		if err != nil {
			return nil, err
		}
		connID := fmt.Sprintf("csv_%d", time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{ID: connID, Type: pool.ConnCSV})

		data, err := adapter.ReadSheet(csvSheetName, 0, 0)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"connId":      connID,
			"filePath":    adapter.GetFilePath(),
			"sheetNames":  adapter.GetSheetNames(),
			"initialData": data,
		}, nil
	}
}

func handleCsvGetSheetNames(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"sheetNames": adapter.GetSheetNames()}, nil
	}
}

func handleCsvReadSheet(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			SheetName string `json:"sheetName"`
			Offset    int    `json:"offset,omitempty"`
			Limit     int    `json:"limit,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ReadSheet(p.SheetName, p.Offset, p.Limit)
	}
}

func handleCsvWriteCells(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string       `json:"connId"`
			Cells  []CellChange `json:"cells"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.WriteCells(p.Cells); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleCsvWriteHeaders(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID  string   `json:"connId"`
			Headers []string `json:"headers"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.WriteHeaders(p.Headers); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleCsvSave(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.Save(); err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"ok":       true,
			"filePath": adapter.GetFilePath(),
		}, nil
	}
}

func handleCsvInsertRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Row    int    `json:"row"`
			Count  int    `json:"count,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.InsertRows(p.Row, p.Count); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleCsvDeleteRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Row    int    `json:"row"`
			Count  int    `json:"count,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.DeleteRows(p.Row, p.Count); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleCsvInsertCols(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Col    int    `json:"col"`
			Count  int    `json:"count,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.InsertCols(p.Col, p.Count); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleCsvDeleteCols(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Col    int    `json:"col"`
			Count  int    `json:"count,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.DeleteCols(p.Col, p.Count); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleCsvSortRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID     string `json:"connId"`
			Col        int    `json:"col"`
			Descending bool   `json:"descending,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.SortRows(p.Col, p.Descending); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}

func handleCsvFindReplace(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID  string             `json:"connId"`
			Options FindReplaceOptions `json:"options"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		replaced, err := adapter.FindReplace(p.Options)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"ok":       true,
			"replaced": replaced,
		}, nil
	}
}

func handleCsvRemoveDuplicates(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID  string `json:"connId"`
			Columns []int  `json:"columns"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getCSVAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		removed, err := adapter.RemoveDuplicates(p.Columns)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"removed": removed,
			"ok":      true,
		}, nil
	}
}

func handleCsvNoop(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if _, err := getCSVAdapter(mgr, p.ConnID); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
}
