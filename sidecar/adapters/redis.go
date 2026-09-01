package adapters

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// RedisAdapter 封装 Redis 连接
type RedisAdapter struct {
	mu     sync.RWMutex // 保护 client 与 conn,Select 切换数据库时写锁互斥
	client *redis.Client
	conn   *RedisConnInfo
	ctx    context.Context
}

// RedisConnInfo Redis 连接参数
type RedisConnInfo struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Password string `json:"password,omitempty"`
	DB       int    `json:"db"`
	SSL      bool   `json:"ssl,omitempty"`
}

// RedisKeyInfo Key 信息
type RedisKeyInfo struct {
	Key  string `json:"key"`
	Type string `json:"type"`
	TTL  int64  `json:"ttl"` // -1 = no expire, -2 = not found
	Size int64  `json:"size,omitempty"`
}

// RedisValueResult 值查询结果
type RedisValueResult struct {
	Key   string      `json:"key"`
	Type  string      `json:"type"`
	Value interface{} `json:"value"`
	TTL   int64       `json:"ttl"`
	Size  int64       `json:"size,omitempty"`
}

// RedisStreamEntry Stream 消息展示结构
type RedisStreamEntry struct {
	ID     string            `json:"id"`
	Values map[string]string `json:"values"`
}

// RedisScanResult SCAN 结果
type RedisScanResult struct {
	Keys   []RedisKeyInfo `json:"keys"`
	Cursor uint64         `json:"cursor"`
	Total  int            `json:"total,omitempty"`
}

// RedisCommandResult 命令执行结果
type RedisCommandResult struct {
	Result     interface{} `json:"result"`
	DurationMs int64       `json:"durationMs"`
	Error      string      `json:"error,omitempty"`
}

const redisValueSampleLimit int64 = 1000

// NewRedisAdapter 创建 Redis 适配器
func NewRedisAdapter(info *RedisConnInfo) (*RedisAdapter, error) {
	client, err := newRedisClient(info)
	if err != nil {
		return nil, err
	}

	log.Info().Str("host", info.Host).Int("port", info.Port).Int("db", info.DB).Msg("redis connected")

	return &RedisAdapter{
		client: client,
		conn:   info,
		ctx:    context.Background(),
	}, nil
}

func newRedisClient(info *RedisConnInfo) (*redis.Client, error) {
	if info.Port == 0 {
		info.Port = 6379
	}

	opts := &redis.Options{
		Addr:         fmt.Sprintf("%s:%d", info.Host, info.Port),
		Password:     info.Password,
		DB:           info.DB,
		DialTimeout:  10 * time.Second,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		PoolSize:     10,
		MinIdleConns: 2,
	}

	if info.SSL {
		// go-redis v9 只有 TLSConfig 非 nil 才启用 TLS;证书校验策略与 ClickHouse 一致(默认校验)。
		opts.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	client := redis.NewClient(opts)
	pingCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("redis connect failed: %w", err)
	}

	return client, nil
}

// Close 关闭连接
func (a *RedisAdapter) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.client.Close()
}

// Ping 检测连接
func (a *RedisAdapter) Ping() error {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client.Ping(a.ctx).Err()
}

// Select 切换数据库
func (a *RedisAdapter) Select(db int) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn != nil && a.conn.DB == db {
		return nil
	}

	nextInfo := *a.conn
	nextInfo.DB = db
	nextClient, err := newRedisClient(&nextInfo)
	if err != nil {
		return err
	}

	oldClient := a.client
	a.client = nextClient
	a.conn.DB = db
	if oldClient != nil {
		_ = oldClient.Close()
	}
	return nil
}

// GetDB 当前数据库编号
func (a *RedisAdapter) GetDB() int {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.conn.DB
}

// Info 获取 Redis INFO
func (a *RedisAdapter) RedisInfo(section string) (string, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if section == "" {
		section = "default"
	}
	return a.client.Info(a.ctx, section).Result()
}

// DBSize 当前 DB 的 key 数量
func (a *RedisAdapter) DBSize() (int64, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client.DBSize(a.ctx).Result()
}

// Scan SCAN 扫描 key
func (a *RedisAdapter) Scan(cursor uint64, match string, count int64) (*RedisScanResult, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if match == "" {
		match = "*"
	}
	if count <= 0 {
		count = 100
	}

	keys, newCursor, err := a.client.Scan(a.ctx, cursor, match, count).Result()
	if err != nil {
		return nil, fmt.Errorf("scan: %w", err)
	}

	keyInfos, err := a.keyInfos(keys, "")
	if err != nil {
		return nil, fmt.Errorf("scan key info: %w", err)
	}

	return &RedisScanResult{
		Keys:   keyInfos,
		Cursor: newCursor,
	}, nil
}

func (a *RedisAdapter) keyInfos(keys []string, typeFilter string) ([]RedisKeyInfo, error) {
	if len(keys) == 0 {
		return []RedisKeyInfo{}, nil
	}

	typeCmds := make([]*redis.StatusCmd, len(keys))
	ttlCmds := make([]*redis.DurationCmd, len(keys))
	_, err := a.client.Pipelined(a.ctx, func(pipe redis.Pipeliner) error {
		for i, key := range keys {
			typeCmds[i] = pipe.Type(a.ctx, key)
			ttlCmds[i] = pipe.TTL(a.ctx, key)
		}
		return nil
	})
	if err != nil && err != redis.Nil {
		return nil, err
	}

	keyInfos := make([]RedisKeyInfo, 0, len(keys))
	for i, key := range keys {
		keyType, err := typeCmds[i].Result()
		if err != nil || keyType == "none" {
			continue
		}
		if typeFilter != "" && typeFilter != "all" && keyType != typeFilter {
			continue
		}
		ttl, err := ttlCmds[i].Result()
		if err != nil {
			ttl = -1 * time.Second
		}
		keyInfos = append(keyInfos, RedisKeyInfo{
			Key:  key,
			Type: keyType,
			TTL:  int64(ttl / time.Second),
		})
	}
	return keyInfos, nil
}

// Type 获取 key 类型
func (a *RedisAdapter) GetType(key string) (string, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client.Type(a.ctx, key).Result()
}

// TTL 获取 key 的 TTL
func (a *RedisAdapter) TTL(key string) (int64, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	ttl, err := a.client.TTL(a.ctx, key).Result()
	if err != nil {
		return 0, err
	}
	return int64(ttl / time.Second), nil
}

// Del 删除 key
func (a *RedisAdapter) Del(keys ...string) (int64, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client.Del(a.ctx, keys...).Result()
}

// Rename 重命名 key
func (a *RedisAdapter) Rename(oldKey, newKey string) error {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client.Rename(a.ctx, oldKey, newKey).Err()
}

// Set 设置值
func (a *RedisAdapter) Set(key string, value interface{}, expiration time.Duration) error {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client.Set(a.ctx, key, value, expiration).Err()
}

// GetValue 获取 key 的值（根据类型返回不同结构）
func (a *RedisAdapter) GetValue(key string) (*RedisValueResult, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	keyType, err := a.client.Type(a.ctx, key).Result()
	if err != nil {
		return nil, fmt.Errorf("type: %w", err)
	}

	ttl, err := a.client.TTL(a.ctx, key).Result()
	if err != nil {
		ttl = -1 * time.Second
	}
	result := &RedisValueResult{
		Key:  key,
		Type: keyType,
		TTL:  int64(ttl / time.Second),
	}

	switch keyType {
	case "string":
		val, err := a.client.Get(a.ctx, key).Result()
		if err == redis.Nil {
			result.Type = "none"
			result.TTL = -2
			result.Value = nil
			result.Size = 0
			return result, nil
		}
		if err != nil {
			return nil, err
		}
		result.Value = val
		result.Size = int64(len(val))

	case "hash":
		length, _ := a.client.HLen(a.ctx, key).Result()
		scanned, _, err := a.client.HScan(a.ctx, key, 0, "", redisValueSampleLimit).Result()
		if err != nil {
			return nil, err
		}
		val := make(map[string]string, len(scanned)/2)
		for i := 0; i+1 < len(scanned); i += 2 {
			val[scanned[i]] = scanned[i+1]
		}
		result.Value = val
		result.Size = length

	case "list":
		length, _ := a.client.LLen(a.ctx, key).Result()
		// 限制获取数量
		end := length - 1
		if end >= redisValueSampleLimit {
			end = redisValueSampleLimit - 1
		}
		val, err := a.client.LRange(a.ctx, key, 0, end).Result()
		if err != nil {
			return nil, err
		}
		result.Value = val
		result.Size = length

	case "set":
		length, _ := a.client.SCard(a.ctx, key).Result()
		val, _, err := a.client.SScan(a.ctx, key, 0, "", redisValueSampleLimit).Result()
		if err != nil {
			return nil, err
		}
		result.Value = val
		result.Size = length

	case "zset":
		// 返回带分数的列表
		val, err := a.client.ZRangeWithScores(a.ctx, key, 0, redisValueSampleLimit-1).Result()
		if err != nil {
			return nil, err
		}
		type ZMember struct {
			Value string  `json:"value"`
			Score float64 `json:"score"`
		}
		members := make([]ZMember, len(val))
		for i, z := range val {
			members[i] = ZMember{
				Value: fmt.Sprintf("%v", z.Member),
				Score: z.Score,
			}
		}
		result.Value = members
		card, _ := a.client.ZCard(a.ctx, key).Result()
		result.Size = card

	case "stream":
		val, err := a.client.XRangeN(a.ctx, key, "-", "+", 1000).Result()
		if err != nil {
			return nil, err
		}
		entries := make([]RedisStreamEntry, len(val))
		for i, msg := range val {
			values := make(map[string]string, len(msg.Values))
			for field, value := range msg.Values {
				values[field] = fmt.Sprintf("%v", value)
			}
			entries[i] = RedisStreamEntry{
				ID:     msg.ID,
				Values: values,
			}
		}
		result.Value = entries
		length, _ := a.client.XLen(a.ctx, key).Result()
		result.Size = length

	case "none":
		result.TTL = -2
		result.Value = nil
		result.Size = 0

	default:
		result.Value = fmt.Sprintf("unsupported type: %s", keyType)
	}

	return result, nil
}

// Get 执行 GET
func (a *RedisAdapter) Get(key string) (string, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client.Get(a.ctx, key).Result()
}

// HGetAll 执行 HGETALL
func (a *RedisAdapter) HGetAll(key string) (map[string]string, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client.HGetAll(a.ctx, key).Result()
}

// LRange 执行 LRANGE
func (a *RedisAdapter) LRange(key string, start, stop int64) ([]string, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client.LRange(a.ctx, key, start, stop).Result()
}

// SMembers 执行 SMEMBERS
func (a *RedisAdapter) SMembers(key string) ([]string, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client.SMembers(a.ctx, key).Result()
}

// ZRangeWithScores 执行 ZRANGE WITHSCORES
func (a *RedisAdapter) ZRangeWithScores(key string, start, stop int64) ([]redis.Z, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.client.ZRangeWithScores(a.ctx, key, start, stop).Result()
}

// Execute 通用命令执行（通过解析命令字符串）
func (a *RedisAdapter) Execute(command string) (*RedisCommandResult, error) {
	start := time.Now()
	command = strings.TrimSpace(command)
	if command == "" {
		return &RedisCommandResult{Error: "empty command"}, nil
	}

	parts := parseRedisCommand(command)
	if len(parts) == 0 {
		return &RedisCommandResult{Error: "invalid command"}, nil
	}

	args := make([]interface{}, len(parts))
	for i, p := range parts {
		args[i] = p
	}

	cmd := strings.ToUpper(parts[0])

	// SELECT 需要写锁切换客户端,单独处理,避免在读锁内调用 Select 死锁。
	if cmd == "SELECT" {
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "SELECT requires db number"}, nil
		}
		db, perr := strconv.Atoi(parts[1])
		if perr != nil {
			return &RedisCommandResult{Error: "invalid db number: " + parts[1]}, nil
		}
		if err := a.Select(db); err != nil {
			return &RedisCommandResult{
				Error:      err.Error(),
				DurationMs: time.Since(start).Milliseconds(),
			}, nil
		}
		return &RedisCommandResult{
			Result:     "OK",
			DurationMs: time.Since(start).Milliseconds(),
		}, nil
	}

	a.mu.RLock()
	defer a.mu.RUnlock()

	var result interface{}
	var err error

	switch cmd {
	case "GET":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "GET requires a key"}, nil
		}
		result, err = a.client.Get(a.ctx, parts[1]).Result()
		if err == redis.Nil {
			result = nil
			err = nil
		}

	case "SET":
		if len(parts) < 3 {
			return &RedisCommandResult{Error: "SET requires key and value"}, nil
		}
		err = a.client.Set(a.ctx, parts[1], parts[2], 0).Err()
		result = "OK"

	case "DEL":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "DEL requires a key"}, nil
		}
		keys := make([]string, len(parts)-1)
		copy(keys, parts[1:])
		var n int64
		n, err = a.client.Del(a.ctx, keys...).Result()
		result = n

	case "EXISTS":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "EXISTS requires a key"}, nil
		}
		var n int64
		n, err = a.client.Exists(a.ctx, parts[1]).Result()
		result = n

	case "KEYS":
		pattern := "*"
		if len(parts) > 1 {
			pattern = parts[1]
		}
		result, err = a.client.Keys(a.ctx, pattern).Result()

	case "TYPE":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "TYPE requires a key"}, nil
		}
		result, err = a.client.Type(a.ctx, parts[1]).Result()

	case "TTL":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "TTL requires a key"}, nil
		}
		var ttl time.Duration
		ttl, err = a.client.TTL(a.ctx, parts[1]).Result()
		result = int64(ttl / time.Second)

	case "PTTL":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "PTTL requires a key"}, nil
		}
		var ttl time.Duration
		ttl, err = a.client.PTTL(a.ctx, parts[1]).Result()
		result = int64(ttl / time.Millisecond)

	case "HGET":
		if len(parts) < 3 {
			return &RedisCommandResult{Error: "HGET requires key and field"}, nil
		}
		result, err = a.client.HGet(a.ctx, parts[1], parts[2]).Result()
		if err == redis.Nil {
			result = nil
			err = nil
		}

	case "HGETALL":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "HGETALL requires a key"}, nil
		}
		result, err = a.client.HGetAll(a.ctx, parts[1]).Result()

	case "HSET":
		if len(parts) < 4 || (len(parts)-2)%2 != 0 {
			return &RedisCommandResult{Error: "HSET requires key field value [field value ...]"}, nil
		}
		args := make([]interface{}, len(parts)-2)
		for i, p := range parts[2:] {
			args[i] = p
		}
		var n int64
		n, err = a.client.HSet(a.ctx, parts[1], args...).Result()
		result = n

	case "HDEL":
		if len(parts) < 3 {
			return &RedisCommandResult{Error: "HDEL requires key and fields"}, nil
		}
		fields := make([]string, len(parts)-2)
		copy(fields, parts[2:])
		var n int64
		n, err = a.client.HDel(a.ctx, parts[1], fields...).Result()
		result = n

	case "LLEN":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "LLEN requires a key"}, nil
		}
		result, err = a.client.LLen(a.ctx, parts[1]).Result()

	case "LRANGE":
		if len(parts) < 4 {
			return &RedisCommandResult{Error: "LRANGE requires key start stop"}, nil
		}
		start, perr := strconv.ParseInt(parts[2], 10, 64)
		if perr != nil {
			return &RedisCommandResult{Error: "invalid start: " + parts[2]}, nil
		}
		stop, perr := strconv.ParseInt(parts[3], 10, 64)
		if perr != nil {
			return &RedisCommandResult{Error: "invalid stop: " + parts[3]}, nil
		}
		result, err = a.client.LRange(a.ctx, parts[1], start, stop).Result()

	case "LPUSH":
		if len(parts) < 3 {
			return &RedisCommandResult{Error: "LPUSH requires key and values"}, nil
		}
		vals := make([]interface{}, len(parts)-2)
		for i, p := range parts[2:] {
			vals[i] = p
		}
		result, err = a.client.LPush(a.ctx, parts[1], vals...).Result()

	case "RPUSH":
		if len(parts) < 3 {
			return &RedisCommandResult{Error: "RPUSH requires key and values"}, nil
		}
		vals := make([]interface{}, len(parts)-2)
		for i, p := range parts[2:] {
			vals[i] = p
		}
		result, err = a.client.RPush(a.ctx, parts[1], vals...).Result()

	case "SADD":
		if len(parts) < 3 {
			return &RedisCommandResult{Error: "SADD requires key and members"}, nil
		}
		members := make([]interface{}, len(parts)-2)
		for i, p := range parts[2:] {
			members[i] = p
		}
		result, err = a.client.SAdd(a.ctx, parts[1], members...).Result()

	case "SCARD":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "SCARD requires a key"}, nil
		}
		result, err = a.client.SCard(a.ctx, parts[1]).Result()

	case "ZADD":
		if len(parts) < 4 || (len(parts)-2)%2 != 0 {
			return &RedisCommandResult{Error: "ZADD requires key score member [score member ...]"}, nil
		}
		zs := make([]redis.Z, 0, (len(parts)-2)/2)
		for i := 2; i < len(parts); i += 2 {
			score, perr := strconv.ParseFloat(parts[i], 64)
			if perr != nil {
				return &RedisCommandResult{Error: "invalid score: " + parts[i]}, nil
			}
			zs = append(zs, redis.Z{Score: score, Member: parts[i+1]})
		}
		result, err = a.client.ZAdd(a.ctx, parts[1], zs...).Result()

	case "ZCARD":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "ZCARD requires a key"}, nil
		}
		result, err = a.client.ZCard(a.ctx, parts[1]).Result()

	case "ZRANGE":
		if len(parts) < 4 {
			return &RedisCommandResult{Error: "ZRANGE requires key start stop"}, nil
		}
		start, perr := strconv.ParseInt(parts[2], 10, 64)
		if perr != nil {
			return &RedisCommandResult{Error: "invalid start: " + parts[2]}, nil
		}
		stop, perr := strconv.ParseInt(parts[3], 10, 64)
		if perr != nil {
			return &RedisCommandResult{Error: "invalid stop: " + parts[3]}, nil
		}
		result, err = a.client.ZRange(a.ctx, parts[1], start, stop).Result()

	case "INCR":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "INCR requires a key"}, nil
		}
		result, err = a.client.Incr(a.ctx, parts[1]).Result()

	case "DECR":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "DECR requires a key"}, nil
		}
		result, err = a.client.Decr(a.ctx, parts[1]).Result()

	case "EXPIRE":
		if len(parts) < 3 {
			return &RedisCommandResult{Error: "EXPIRE requires key and seconds"}, nil
		}
		sec, perr := strconv.ParseInt(parts[2], 10, 64)
		if perr != nil {
			return &RedisCommandResult{Error: "invalid seconds: " + parts[2]}, nil
		}
		result, err = a.client.Expire(a.ctx, parts[1], time.Duration(sec)*time.Second).Result()

	case "PERSIST":
		if len(parts) < 2 {
			return &RedisCommandResult{Error: "PERSIST requires a key"}, nil
		}
		result, err = a.client.Persist(a.ctx, parts[1]).Result()

	case "PING":
		result, err = a.client.Ping(a.ctx).Result()

	case "DBSIZE":
		result, err = a.client.DBSize(a.ctx).Result()

	case "INFO":
		section := ""
		if len(parts) > 1 {
			section = parts[1]
		}
		result, err = a.client.Info(a.ctx, section).Result()

	case "FLUSHDB":
		err = a.client.FlushDB(a.ctx).Err()
		if err == nil {
			result = "OK"
		}

	default:
		// 尝试作为通用命令执行
		result, err = a.client.Do(a.ctx, args...).Result()
	}

	if err != nil {
		return &RedisCommandResult{
			Error:      err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
		}, nil
	}

	return &RedisCommandResult{
		Result:     result,
		DurationMs: time.Since(start).Milliseconds(),
	}, nil
}

// parseRedisCommand 简单解析 Redis 命令（处理引号）。空引用串（如 `""`）必须保留为
// 一个空 token——Hash/List 成员值可为空字符串,依赖 `redisQuote("")` 生成 `""`,若
// 被丢弃则 HSET/LSET 等命令会因参数不足报错。
func parseRedisCommand(command string) []string {
	var parts []string
	var current strings.Builder
	inQuote := false
	quoteChar := byte(0)
	inToken := false

	for i := 0; i < len(command); i++ {
		ch := command[i]

		if inQuote {
			if ch == '\\' && i+1 < len(command) {
				current.WriteByte(command[i+1])
				i++
				continue
			}
			if ch == quoteChar {
				inQuote = false
			} else {
				current.WriteByte(ch)
			}
		} else {
			if ch == '"' || ch == '\'' {
				inQuote = true
				inToken = true
				quoteChar = ch
			} else if ch == ' ' || ch == '\t' {
				if inToken {
					parts = append(parts, current.String())
					current.Reset()
					inToken = false
				}
			} else {
				current.WriteByte(ch)
				inToken = true
			}
		}
	}

	if inToken {
		parts = append(parts, current.String())
	}

	return parts
}

// SlowlogEntry 慢查询条目
type SlowlogEntry struct {
	ID        int64  `json:"id"`
	Duration  int64  `json:"duration"`
	Timestamp int64  `json:"timestamp"`
	Command   string `json:"command"`
}

// SlowlogGet 获取慢查询日志
func (a *RedisAdapter) SlowlogGet(count int64) ([]SlowlogEntry, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	result, err := a.client.SlowLogGet(a.ctx, count).Result()
	if err != nil {
		return nil, fmt.Errorf("slowlog get: %w", err)
	}
	entries := make([]SlowlogEntry, len(result))
	for i, r := range result {
		entries[i] = SlowlogEntry{
			ID:        r.ID,
			Duration:  r.Duration.Microseconds(),
			Timestamp: r.Time.Unix(),
			Command:   strings.Join(r.Args, " "),
		}
	}
	return entries, nil
}

// SlowlogReset 重置慢查询日志
func (a *RedisAdapter) SlowlogReset() error {
	a.mu.RLock()
	defer a.mu.RUnlock()
	_, err := a.client.SlowLogReset(a.ctx).Result()
	if err != nil {
		return fmt.Errorf("slowlog reset: %w", err)
	}
	return nil
}

// ScanAll 全量扫描所有 key（带类型过滤）
func (a *RedisAdapter) ScanAll(match string, count int64, typeFilter string) ([]RedisKeyInfo, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	var allKeys []RedisKeyInfo
	var cursor uint64 = 0
	if count <= 0 {
		count = 200
	}
	for {
		keys, nextCursor, err := a.client.Scan(a.ctx, cursor, match, count).Result()
		if err != nil {
			return nil, fmt.Errorf("scan all: %w", err)
		}
		keyInfos, err := a.keyInfos(keys, typeFilter)
		if err != nil {
			return nil, fmt.Errorf("scan all key info: %w", err)
		}
		allKeys = append(allKeys, keyInfos...)
		cursor = nextCursor
		if cursor == 0 {
			break
		}
	}
	return allKeys, nil
}

// BigKeyEntry 大 key 条目
type BigKeyEntry struct {
	Key    string `json:"key"`
	Type   string `json:"type"`
	Size   int64  `json:"size"`
	Length int64  `json:"length"`
}

// BigKeyScan 扫描大 key
func (a *RedisAdapter) BigKeyScan(match string, stringThreshold, memberThreshold int64) ([]BigKeyEntry, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	results := make([]BigKeyEntry, 0)
	var cursor uint64 = 0
	for {
		keys, nextCursor, err := a.client.Scan(a.ctx, cursor, match, 200).Result()
		if err != nil {
			return nil, fmt.Errorf("bigkey scan: %w", err)
		}
		for _, key := range keys {
			keyType, err := a.client.Type(a.ctx, key).Result()
			if err != nil {
				continue
			}
			switch keyType {
			case "string":
				if size, err := a.client.StrLen(a.ctx, key).Result(); err == nil && size >= stringThreshold {
					results = append(results, BigKeyEntry{Key: key, Type: keyType, Size: size})
				}
			case "hash":
				if length, err := a.client.HLen(a.ctx, key).Result(); err == nil && length >= memberThreshold {
					results = append(results, BigKeyEntry{Key: key, Type: keyType, Length: length})
				}
			case "list":
				if length, err := a.client.LLen(a.ctx, key).Result(); err == nil && length >= memberThreshold {
					results = append(results, BigKeyEntry{Key: key, Type: keyType, Length: length})
				}
			case "set":
				if length, err := a.client.SCard(a.ctx, key).Result(); err == nil && length >= memberThreshold {
					results = append(results, BigKeyEntry{Key: key, Type: keyType, Length: length})
				}
			case "zset":
				if length, err := a.client.ZCard(a.ctx, key).Result(); err == nil && length >= memberThreshold {
					results = append(results, BigKeyEntry{Key: key, Type: keyType, Length: length})
				}
			}
		}
		cursor = nextCursor
		if cursor == 0 {
			break
		}
	}
	sort.Slice(results, func(i, j int) bool {
		return results[i].Size+results[i].Length > results[j].Size+results[j].Length
	})
	return results, nil
}

// MemoryAnalysisEntry 内存分析条目
type MemoryAnalysisEntry struct {
	Prefix     string  `json:"prefix"`
	Keys       int64   `json:"keys"`
	Memory     int64   `json:"memory"`
	Percentage float64 `json:"percentage"`
}

// MemoryAnalysis 按 key 前缀分析内存使用
func (a *RedisAdapter) MemoryAnalysis(match string, sampleSize int) ([]MemoryAnalysisEntry, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	type agg struct {
		Keys, Memory int64
	}
	prefixes := map[string]*agg{}
	var cursor uint64 = 0
	var total int64 = 0
	for {
		keys, nextCursor, err := a.client.Scan(a.ctx, cursor, match, 200).Result()
		if err != nil {
			return nil, fmt.Errorf("memory scan: %w", err)
		}
		for _, key := range keys {
			prefix := key
			if idx := strings.Index(key, ":"); idx != -1 {
				prefix = key[:idx+1] + "*"
			} else {
				prefix = "<no prefix>"
			}
			if _, ok := prefixes[prefix]; !ok {
				prefixes[prefix] = &agg{}
			}
			prefixes[prefix].Keys++
			if sampleSize <= 0 || prefixes[prefix].Keys <= int64(sampleSize) {
				if mem, err := a.client.MemoryUsage(a.ctx, key, 0).Result(); err == nil {
					prefixes[prefix].Memory += mem
					total += mem
				}
			}
		}
		cursor = nextCursor
		if cursor == 0 {
			break
		}
	}
	results := make([]MemoryAnalysisEntry, 0)
	for prefix, ag := range prefixes {
		pct := float64(0)
		if total > 0 {
			pct = float64(ag.Memory) / float64(total) * 100
		}
		results = append(results, MemoryAnalysisEntry{
			Prefix:     prefix,
			Keys:       ag.Keys,
			Memory:     ag.Memory,
			Percentage: pct,
		})
	}
	sort.Slice(results, func(i, j int) bool {
		return results[i].Memory > results[j].Memory
	})
	return results, nil
}

// FlushDB 清空当前数据库
func (a *RedisAdapter) FlushDB() error {
	a.mu.RLock()
	defer a.mu.RUnlock()
	_, err := a.client.FlushDB(a.ctx).Result()
	if err != nil {
		return fmt.Errorf("flushdb: %w", err)
	}
	return nil
}

// RedisPubSubMessage PubSub 消息
type RedisPubSubMessage struct {
	Channel string `json:"channel"`
	Pattern string `json:"pattern,omitempty"`
	Payload string `json:"payload"`
}

// Subscribe 订阅指定频道和模式，阻塞等待 timeoutMs 毫秒收集消息
func (a *RedisAdapter) Subscribe(channels, patterns []string, timeoutMs int) ([]RedisPubSubMessage, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if len(channels) == 0 && len(patterns) == 0 {
		return nil, fmt.Errorf("at least one channel or pattern is required")
	}
	if timeoutMs <= 0 {
		timeoutMs = 5000
	}

	// 使用单独的 PubSub 实例订阅频道和模式
	var pubsub *redis.PubSub
	if len(channels) > 0 {
		pubsub = a.client.Subscribe(a.ctx, channels...)
		if len(patterns) > 0 {
			if err := pubsub.PSubscribe(a.ctx, patterns...); err != nil {
				pubsub.Close()
				return nil, fmt.Errorf("psubscribe: %w", err)
			}
		}
	} else {
		pubsub = a.client.PSubscribe(a.ctx, patterns...)
	}
	defer pubsub.Close()

	var messages []RedisPubSubMessage
	timeout := time.After(time.Duration(timeoutMs) * time.Millisecond)
	msgCh := pubsub.Channel()

	for {
		select {
		case msg, ok := <-msgCh:
			if !ok {
				return messages, nil
			}
			messages = append(messages, RedisPubSubMessage{
				Channel: msg.Channel,
				Pattern: msg.Pattern,
				Payload: msg.Payload,
			})
		case <-timeout:
			return messages, nil
		}
	}
}

// Unsubscribe 取消订阅指定频道
func (a *RedisAdapter) Unsubscribe(channels []string) error {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if len(channels) == 0 {
		return nil
	}

	pubsub := a.client.Subscribe(a.ctx)
	defer pubsub.Close()

	err := pubsub.Unsubscribe(a.ctx, channels...)
	if err != nil {
		return fmt.Errorf("unsubscribe: %w", err)
	}
	return nil
}

// MarshalJSON 为 RedisAdapter 提供自定义 JSON 序列化（避免导出 ctx）
func (a *RedisAdapter) MarshalJSON() ([]byte, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return json.Marshal(map[string]interface{}{
		"host": a.conn.Host,
		"port": a.conn.Port,
		"db":   a.conn.DB,
	})
}
