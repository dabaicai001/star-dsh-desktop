"""SSH server with exec + SFTP subsystem support for StarHub sidecar testing.

Listens on 127.0.0.1:2224, user: testuser / testpass. Handles `exec` requests
by running the command through /bin/sh (POSIX) or cmd.exe (Windows) and
returning stdout+stderr plus the exit status, and handles the `sftp`
subsystem through paramiko's built-in SFTPServer so SFTP tools have a real
remote filesystem to talk about.

Companion to direct_tcpip_server.py (2223, forwarding only); this one exists
so the Rust sidecar's ssh_exec / sftp_* methods can be exercised end to end
against a live server:

    python test-sftp/exec_server.py

The Rust integration test probes the port first and skips when the server is
not running, so `cargo test` stays green without it.
"""
import os
import socket
import subprocess
import sys
import threading

import paramiko
from paramiko import RSAKey
from paramiko.sftp_server import SFTPServer

HOST = "127.0.0.1"
PORT = 2224
USERNAME = "testuser"
PASSWORD = "testpass"
# SFTP 根目录:仓库里的 test-sftp/sftp-root(不存在则用临时目录)
SFTP_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sftp-root")


class StubSFTPInterface(paramiko.SFTPServerInterface):
    """把 SFTP 根目录固定到 test-sftp/sftp-root 的服务端实现。"""

    def __init__(self, server, *args, **kwargs):
        super().__init__(server, *args, **kwargs)
        self.root = SFTP_ROOT

    def _resolve(self, path):
        return os.path.join(self.root, path.lstrip("/").replace("/", os.sep))

    def session_started(self):
        pass

    def canonicalize(self, path):
        return "/" + path.lstrip("/")

    def list_folder(self, path):
        import stat as stat_module

        target = self._resolve(path)
        out = []
        for name in sorted(os.listdir(target)):
            full = os.path.join(target, name)
            attributes = paramiko.SFTPAttributes.from_stat(os.stat(full))
            attributes.filename = name
            out.append(attributes)
        return out

    def stat(self, path):
        return paramiko.SFTPAttributes.from_stat(os.stat(self._resolve(path)))

    def lstat(self, path):
        return paramiko.SFTPAttributes.from_stat(os.lstat(self._resolve(path)))

    def open(self, path, flags, attr):
        target = self._resolve(path)
        mode = getattr(os, "O_RDWR", 2)
        if flags & getattr(os, "O_WRONLY", 1):
            mode = getattr(os, "O_WRONLY", 1)
        elif flags & getattr(os, "O_RDONLY", 0):
            mode = getattr(os, "O_RDONLY", 0)
        fd = os.open(target, mode | getattr(os, "O_BINARY", 0))
        return paramiko.SFTPHandle(flags)

    def remove(self, path):
        os.remove(self._resolve(path))

    def rename(self, oldpath, newpath):
        os.rename(self._resolve(oldpath), self._resolve(newpath))

    def mkdir(self, path, attr):
        os.mkdir(self._resolve(path))

    def rmdir(self, path):
        os.rmdir(self._resolve(path))

    def chattr(self, path, attr):
        pass


class ExecServer(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        if username == USERNAME and password == PASSWORD:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, chanid):
        if kind == "session":
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_subsystem_request(self, channel, name):
        if name == "sftp":
            # paramiko 的 SFTPServer 是 SubsystemHandler(Thread):构造后必须
            # start() 才会跑 SFTP 协议循环,否则客户端只会收到 EOF。
            # 返回值必须是真值(OPEN_SUCCEEDED 是 0 = 假,会被判为拒绝)。
            sftp = SFTPServer(channel, "sftp", self, sftp_si=StubSFTPInterface)
            sftp.start()
            return True
        return False

    def check_channel_exec_request(self, channel, command):
        # exec 请求自带命令正文:起线程执行并把输出回写同一通道
        threading.Thread(
            target=handle_channel, args=(channel, command), daemon=True
        ).start()
        return True


def run_command(command):
    """在宿主机上执行命令,返回 (stdout+stderr, exit_code)。"""
    if os.name == "nt":
        proc = subprocess.run(
            ["cmd.exe", "/c", command], capture_output=True, text=True, timeout=30
        )
    else:
        proc = subprocess.run(
            ["/bin/sh", "-c", command], capture_output=True, text=True, timeout=30
        )
    return (proc.stdout or "") + (proc.stderr or ""), proc.returncode


def handle_channel(channel, command):
    try:
        output, code = run_command(command)
    except subprocess.TimeoutExpired:
        output, code = "command timed out", 124
    except Exception as error:  # noqa: BLE001 - 测试服务器:任何失败都回给客户端
        output, code = f"stub server error: {error}", 1
    try:
        channel.sendall(output.encode("utf-8", "replace"))
        channel.send_exit_status(code)
        channel.close()
    except Exception:
        pass


def handle_client(client, host_key):
    transport = paramiko.Transport(client)
    # 宿主机密钥全程复用一枚:客户端(尤其 TOFU known_hosts 校验)才能跨连接稳定识别
    transport.add_server_key(host_key)
    server = ExecServer()
    try:
        transport.start_server(server=server)
    except Exception:
        return
    # exec / sftp 子系统都在各自的 check_channel_*_request 回调里接管;
    # accept 循环保持 transport 的事件循环继续跑。
    while transport.is_active():
        channel = transport.accept(20)
        if channel is None:
            continue


def main():
    os.makedirs(SFTP_ROOT, exist_ok=True)
    with open(os.path.join(SFTP_ROOT, "hello.txt"), "w", encoding="utf-8") as handle:
        handle.write("hello from the stub sftp server\n")
    host_key_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "host_key.pem")
    if os.path.exists(host_key_path):
        with open(host_key_path, "r", encoding="utf-8") as handle:
            host_key = RSAKey.from_private_key(handle)
    else:
        host_key = RSAKey.generate(2048)
        host_key.write_private_key_file(host_key_path)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((HOST, PORT))
    listener.listen(5)
    print(f"SSH exec/sftp test server on {HOST}:{PORT} (sftp root: {SFTP_ROOT})", flush=True)
    while True:
        client, _ = listener.accept()
        threading.Thread(
            target=handle_client, args=(client, host_key), daemon=True
        ).start()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
