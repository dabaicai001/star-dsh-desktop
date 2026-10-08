package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"github.com/starhub/sidecar/adapters"
	"github.com/starhub/sidecar/pool"
	"github.com/starhub/sidecar/rpc"
)

const (
	sidecarVersion  = "0.7.1"
	protocolVersion = 2
)

func main() {
	// 日志输出到 stderr，不污染 stdout
	log.Logger = zerolog.New(os.Stderr).With().Timestamp().Logger()

	fmt.Fprintf(os.Stderr, "StarHub Sidecar starting...\n")

	server := rpc.NewServer()
	connMgr := pool.NewManager()

	// 注册 ping 方法用于测试连接
	server.Register("ping", func(params json.RawMessage) (interface{}, error) {
		return "pong", nil
	})

	// 注册版本方法
	server.Register("version", func(params json.RawMessage) (interface{}, error) {
		return map[string]interface{}{
			"version":         sidecarVersion,
			"protocolVersion": protocolVersion,
			"go":              "1.25+",
			"modules":         "mysql,postgresql,redis,elasticsearch,clickhouse,kafka,nsq,docker,csv",
			"methods":         server.Methods(),
		}, nil
	})

	// 注册连接列表方法
	server.Register("listConnections", func(params json.RawMessage) (interface{}, error) {
		return connMgr.List(), nil
	})

	// 注册数据库相关方法 (MySQL + Redis)
	adapters.RegisterDBHandlers(server, connMgr)

	// 注册 Docker 方法
	adapters.RegisterDockerHandlers(server, connMgr)

	// 注册 CSV 文件方法
	adapters.RegisterCSVHandlers(server, connMgr)

	fmt.Fprintf(os.Stderr, "StarHub Sidecar ready\n")

	if err := server.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Server error: %v\n", err)
		connMgr.CloseAll()
		os.Exit(1)
	}
}
