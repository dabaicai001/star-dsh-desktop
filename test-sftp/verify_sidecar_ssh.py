"""端到端验证:starhub-sidecar-rust 的 ssh_exec / sftp_list 打到真 SSH 服务器。

流程:
1. 启动 test-sftp/exec_server.py(127.0.0.1:2224,testuser/testpass);
2. 用 paramiko 取宿主机密钥 → 写 known_hosts(TOFU 预信任,M1 的
   AI 会话路径不弹交互确认);
3. 写 assets.json(一条 ssh 资产,密码走内存密钥存储——本脚本用明文 config
   内联,与踩坑记录 §305 的无人值守冒烟配方一致);
4. spawn sidecar 二进制,按 JSON-RPC 逐条发请求并打印应答。

用法:python test-sftp/verify_sidecar_ssh.py [sidecar 可执行路径]
"""
import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time

import paramiko

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
PORT = 2224
USERNAME = "testuser"
PASSWORD = "testpass"


def wait_port(host, port, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def _ssh_string(text):
    raw = text.encode("ascii")
    return len(raw).to_bytes(4, "big") + raw


def _mpint(value):
    if value and value[0] & 0x80:
        value = b"\x00" + value
    return len(value).to_bytes(4, "big") + value


def _split_wire(blob):
    """拆 SSH 线网公钥:<算法名 string><mpint…>;返回 (算法名, 其余 mpint 列表)。"""
    (length,) = struct.unpack(">I", blob[:4])
    algorithm = blob[4 : 4 + length].decode("ascii")
    offset = 4 + length
    parts = []
    while offset < len(blob):
        (length,) = struct.unpack(">I", blob[offset : offset + 4])
        parts.append(blob[offset + 4 : offset + 4 + length])
        offset += 4 + length
    return algorithm, parts


def server_host_keys():
    """返回该服务器的候选 known_hosts 条目清单。

    russh(ssh-key)在解析服务端公钥时可能把算法名规范成 `rsa-sha2-256`,
    指纹是对「重编码后的线网 blob」取的摘要,与服务端原样 blob 的摘要不同。
    这里把两种算法名各生成一条候选,seed 时全量写入——`is_known` 命中任意
    一条即信任,与真实 TOFU(用户在终端确认一次后落库)等价。
    """
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=10)
    key = client.get_transport().get_remote_server_key()
    blob = key.asbytes()
    key_type = key.get_name()
    public_key = base64.b64encode(blob).decode("ascii")
    client.close()

    algorithm, parts = _split_wire(blob)
    candidates = {algorithm}
    if algorithm == "ssh-rsa":
        # RSA 的现代算法名:russh 归一化时用这个
        candidates.add("rsa-sha2-256")
    hosts = []
    for name in sorted(candidates):
        reencoded = _ssh_string(name) + b"".join(_mpint(part) for part in parts)
        hosts.append({
            "host": HOST,
            "port": PORT,
            "keyType": name,
            "fingerprint": "SHA256:"
            + base64.b64encode(hashlib.sha256(reencoded).digest()).decode("ascii").rstrip("="),
            "publicKey": f"{name} {public_key}",
        })
    return key_type, hosts


def main():
    sidecar = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        HERE, "..", "sidecar-rust", "target", "debug", "starhub-sidecar-rust.exe"
    )
    sidecar = os.path.abspath(sidecar)
    if not os.path.exists(sidecar):
        print(f"FATAL: sidecar binary not found: {sidecar}")
        print("build it first: npm run sidecar-rust:build")
        return 2

    server = subprocess.Popen(
        [os.path.join(HERE, ".venv", "Scripts", "python.exe"), os.path.join(HERE, "exec_server.py")],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        if not wait_port(HOST, PORT):
            print("FATAL: stub SSH server did not come up")
            print(server.stdout.read() if server.stdout else "")
            return 2
        key_type, host_entries = server_host_keys()
        print(f"stub server host key: {key_type} ({len(host_entries)} candidate fingerprints)")
        for entry in host_entries:
            print(f"  {entry['keyType']}: {entry['fingerprint']}")

        workdir = tempfile.mkdtemp(prefix="starhub-sidecar-verify-")
        with open(os.path.join(workdir, "known-hosts.json"), "w", encoding="utf-8") as handle:
            json.dump({"hosts": host_entries}, handle)
        with open(os.path.join(workdir, "assets.json"), "w", encoding="utf-8") as handle:
            json.dump(
                {"assets": [{
                    "id": "stub-ssh", "type": "ssh", "name": "stub",
                    "config": {
                        "host": HOST, "port": PORT, "username": USERNAME,
                        "password": PASSWORD, "usePasswordAuth": True,
                    },
                }]},
                handle,
            )

        env = dict(os.environ)
        env["STARHUB_ASSETS_FILE"] = os.path.join(workdir, "assets.json")
        env["STARHUB_SECRETS_FILE"] = ""
        env["STARHUB_KNOWN_HOSTS_FILE"] = os.path.join(workdir, "known-hosts.json")
        child = subprocess.Popen(
            [sidecar], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", env=env, bufsize=1,
        )
        try:
            notifications = []

            def call(request_id, method, params):
                child.stdin.write(json.dumps({
                    "jsonrpc": "2.0", "id": request_id, "method": method, "params": params,
                }) + "\n")
                child.stdin.flush()
                # 跳过通知帧(域事件,无 id):它们排在响应之前刷出来
                while True:
                    line = child.stdout.readline()
                    if not line:
                        raise RuntimeError("sidecar closed stdout")
                    frame = json.loads(line)
                    if "id" in frame:
                        return frame
                    notifications.append(frame)

            failures = []

            def check(label, condition, detail):
                status = "PASS" if condition else "FAIL"
                print(f"[{status}] {label}: {detail}")
                if not condition:
                    failures.append(label)

            # 1) 能力表带全方法面
            reply = call("cap", "starhub_list_capabilities", {})
            methods = reply["result"]["methods"]
            check("capabilities", "ssh_exec" in methods and "sftp_list" in methods, f"{len(methods)} methods")

            # 2) 资产清单
            reply = call("assets", "starhub_list_assets", {})
            assets = json.loads(reply["result"]["text"])
            check("list_assets", len(assets) == 1 and assets[0]["id"] == "stub-ssh", reply["result"]["text"])

            # 3) 会话状态(未连接)
            reply = call("status-0", "ssh_session_status", {"assetId": "stub-ssh"})
            check("status_before", "SSH 会话未建立" in reply["result"]["text"], reply["result"]["text"])

            # 4) 真连 + 真执行
            reply = call("exec", "ssh_exec", {"assetId": "stub-ssh", "command": "echo hello-from-sidecar"})
            print("   raw reply:", json.dumps(reply, ensure_ascii=False))
            text = reply.get("result", {}).get("text", "")
            check("ssh_exec", "hello-from-sidecar" in text, repr(text))

            # 5) 会话状态(已连接)
            reply = call("status-1", "ssh_session_status", {"assetId": "stub-ssh"})
            check("status_after", "SSH 会话已连接" in reply["result"]["text"], reply["result"]["text"])

            # 6) SFTP 列表
            reply = call("sftp", "sftp_list", {"assetId": "stub-ssh", "path": "/"})
            text = reply.get("result", {}).get("text", "")
            check("sftp_list", "FILE" in text or "DIR" in text, repr(text[:200]))

            # 7) 停止生成信号(未知 exec_id:通知无声 + 请求确认)
            child.stdin.write(json.dumps({
                "jsonrpc": "2.0", "method": "starhub/exec.abort", "params": {"execId": "nope"},
            }) + "\n")
            child.stdin.flush()
            reply = call("abort", "starhub/exec.abort", {"execId": "nope"})
            check("exec_abort", reply["result"]["aborted"] is False, reply["result"])

            # 8) 域事件通知(exec 成功后 sidecar 广播 ssh:exec-done)
            event_names = [
                frame.get("params", {}).get("event")
                for frame in notifications
                if frame.get("method") == "starhub/domain-event"
            ]
            check("domain_event", "ssh:exec-done" in event_names, event_names)

            print()
            if failures:
                print(f"RESULT: {len(failures)} check(s) failed: {failures}")
                return 1
            print("RESULT: all checks passed")
            return 0
        finally:
            child.stdin.close()
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
            err = child.stderr.read()
            if err.strip():
                print("--- sidecar stderr ---")
                print(err)
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    sys.exit(main())
