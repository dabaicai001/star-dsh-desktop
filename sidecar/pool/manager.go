package pool

import (
	"fmt"
	"sync"

	"github.com/rs/zerolog/log"
)

// ConnType 表示连接类型
type ConnType string

const (
	ConnMySQL  ConnType = "mysql"
	ConnPG     ConnType = "postgresql"
	ConnRedis  ConnType = "redis"
	ConnDocker ConnType = "docker"
	ConnES     ConnType = "elasticsearch"
	ConnCH     ConnType = "clickhouse"
	ConnCSV    ConnType = "csv"
	ConnSQLite ConnType = "sqlite"
	ConnMSSQL  ConnType = "mssql"
)

// ConnInfo 存储连接元信息
type ConnInfo struct {
	ID       string   `json:"id"`
	Type     ConnType `json:"type"`
	Host     string   `json:"host"`
	Port     int      `json:"port"`
	Database string   `json:"database,omitempty"`
}

// DBAdapter 定义数据库适配器接口
type DBAdapter interface {
	// Close 关闭连接
	Close() error
	// Ping 检测连接存活
	Ping() error
}

// Manager 管理所有数据库连接
type Manager struct {
	mu       sync.RWMutex
	adapters map[string]DBAdapter
	infos    map[string]ConnInfo
}

// NewManager 创建连接管理器
func NewManager() *Manager {
	return &Manager{
		adapters: make(map[string]DBAdapter),
		infos:    make(map[string]ConnInfo),
	}
}

// Register 注册一个连接
func (m *Manager) Register(id string, adapter DBAdapter, info ConnInfo) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.adapters[id] = adapter
	m.infos[id] = info
	log.Info().Str("id", id).Str("type", string(info.Type)).Msg("connection registered")
}

// Get 获取一个连接
func (m *Manager) Get(id string) (DBAdapter, ConnInfo, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	adapter, ok := m.adapters[id]
	if !ok {
		return nil, ConnInfo{}, fmt.Errorf("connection not found: %s", id)
	}
	return adapter, m.infos[id], nil
}

// Remove 移除一个连接
func (m *Manager) Remove(id string) error {
	m.mu.Lock()
	adapter, ok := m.adapters[id]
	if !ok {
		m.mu.Unlock()
		return nil
	}
	delete(m.adapters, id)
	delete(m.infos, id)
	m.mu.Unlock()
	log.Info().Str("id", id).Msg("connection removed")
	// Close 可能涉及网络 I/O(如 Docker),放在锁外执行,避免阻塞其他 Get/Remove。
	return adapter.Close()
}

// List 列出所有连接
func (m *Manager) List() []ConnInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	infos := make([]ConnInfo, 0, len(m.infos))
	for _, info := range m.infos {
		infos = append(infos, info)
	}
	return infos
}

// Has 检查连接是否存在
func (m *Manager) Has(id string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.adapters[id]
	return ok
}

// CloseAll 关闭所有连接
func (m *Manager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, adapter := range m.adapters {
		if err := adapter.Close(); err != nil {
			log.Error().Err(err).Str("id", id).Msg("failed to close adapter")
		}
	}
	m.adapters = make(map[string]DBAdapter)
	m.infos = make(map[string]ConnInfo)
}
