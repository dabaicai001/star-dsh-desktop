"""Fake Go sidecar: speaks the same newline-delimited JSON-RPC 2.0 protocol as
sidecar/starhub-sidecar (protocolVersion 2 + the required method table), with
canned answers for the connect/execute/disconnect chains the DB/Redis/ES/Docker
tool surface drives.

Purpose: contract tests for the Rust sidecar's db_* / redis_exec / es_* /
docker_* methods without a real MySQL/Redis/ES/Docker. Every assertion the
tests make is about the *wire shape* and the *model-facing text format* — the
two things that must not drift when the domain moves between processes.

Run standalone (one request per stdin line, one response per stdout line):

    echo '{"id":"1","method":"version","params":{}}' | python fake-go-sidecar.py
"""
import json
import sys

PROTOCOL_VERSION = 2
VERSION = "fake-go-sidecar/0.1.0"

METHODS = [
    "db.mysql.getTableMeta",
    "db.mysql.getTableData",
    "db.clickhouse.getTableMeta",
    "db.clickhouse.getTableData",
    "file.csv.open",
    "file.csv.readSheet",
    "file.csv.writeCells",
    "file.csv.save",
    "file.csv.removeDuplicates",
    "file.excel.open",
    "file.excel.readSheet",
    "file.excel.writeCells",
    "file.excel.save",
    "file.excel.removeDuplicates",
    "docker.execSessionStart",
    "docker.execSessionRead",
    "docker.execSessionWrite",
    "docker.execSessionResize",
    "docker.execSessionClose",
]

# 每条 connect 递增,便于测试断言「每次调用都是独立连接」
_CONN_COUNTER = {"n": 0}


def _next_conn_id(prefix):
    _CONN_COUNTER["n"] += 1
    return f"{prefix}-{_CONN_COUNTER['n']}"


def handle(request):
    method = request.get("method")
    params = request.get("params") or {}

    if method == "version":
        return {"version": VERSION, "protocolVersion": PROTOCOL_VERSION, "methods": METHODS}

    if method and method.startswith("db.mysql.connect"):
        return {"connId": _next_conn_id("mysql-conn")}
    if method and method.startswith("db.postgres.connect"):
        return {"connId": _next_conn_id("postgres-conn")}
    if method and method.startswith("db.clickhouse.connect"):
        return {"connId": _next_conn_id("clickhouse-conn")}
    if method and method.startswith("db.redis.connect"):
        # 回显 db 参数:测试据此验证 db 覆盖真的传到了连接参数
        return {"connId": _next_conn_id("redis-conn"), "db": params.get("db", 0)}
    if method and method.startswith("db.es.connect"):
        return {"connId": _next_conn_id("es-conn")}
    if method and method.startswith("docker.connect"):
        return {"connId": _next_conn_id("docker-conn")}

    if method in ("db.mysql.execute", "db.clickhouse.execute", "db.postgres.execute"):
        return {
            "columns": [{"name": "id"}, {"name": "name"}],
            "rows": [[1, "alice"], [2, "bob"]],
            "rowsAffected": 0,
        }

    if method == "db.redis.execute":
        command = (params.get("command") or "").strip()
        if command.upper().startswith("GET"):
            return {"result": "cached-value"}
        if command.upper().startswith("SET"):
            return {"result": "OK"}
        return {"result": None}

    if method == "db.es.listIndices":
        return [
            {"name": "logs-2026", "docsCount": 12, "storeSize": "48kb", "health": "green"},
            {"name": "metrics", "docsCount": 3, "storeSize": "12kb", "health": "yellow"},
        ]
    if method == "db.es.clusterHealth":
        return {"status": "green", "numberOfNodes": 3}
    if method == "db.es.search":
        return {"took": 3, "hits": {"total": 1, "hits": [{"_id": "1"}]}}
    if method == "db.es.getDocument":
        return {"_index": params.get("index"), "_id": params.get("id"), "found": True}
    if method == "db.es.count":
        return {"count": 7}
    if method == "db.es.getMapping":
        return {"properties": {"title": {"type": "text"}}}
    if method == "db.es.indexDocument":
        return {"result": "created", "_id": params.get("id", "generated")}
    if method == "db.es.deleteDocument":
        return {"result": "deleted"}
    if method == "db.es.deleteIndex":
        return {"acknowledged": True}

    if method == "docker.listContainers":
        return [
            {
                "id": "abc123def456789",
                "name": "web",
                "image": "nginx:latest",
                "state": "running",
                "status": "Up 2 hours",
            }
        ]
    if method == "docker.containerLogs":
        return [{"stream": "stdout", "message": "listening on :80"}]
    if method == "docker.inspectContainer":
        return {"Id": params.get("containerId"), "State": {"Status": "running"}}
    if method == "docker.exec":
        return {"stdout": "container-output", "stderr": "", "exitCode": 0}

    if method and method.endswith(".disconnect"):
        return {"ok": True}

    # 未知方法:与 Go 侧一致的错误形状
    return {"error": {"code": -32601, "message": f"method not found: {method}"}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue  # 畸形行忽略,与 Rust 侧协议一致
        request_id = request.get("id")
        if request_id is None:
            continue  # 通知不应答
        result = handle(request)
        response = {"jsonrpc": "2.0", "id": request_id}
        if isinstance(result, dict) and set(result.keys()) == {"error"} and isinstance(
            result["error"], dict
        ):
            response["error"] = result["error"]
        else:
            response["result"] = result
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
