/**
 * starhub-approval-bridge 风险门(防误删核心):`classifyStarHubCall` 对
 * ssh_exec / docker_exec 的只读放行与风险升级。本文件钉死两侧边界:
 * - 只读放行:ls / ps / find 纯列举 / docker ps 等;
 * - 风险升级(hard 死规定档):rm(-rf)、find -delete/-exec、ip link del、
 *   journalctl --vacuum、docker rm/rmi/prune/compose down、DROP/TRUNCATE、
 *   Redis DEL 等删除类命令一律 ask,并且 hard=true 表示即使会话策略为
 *   never(全访问)也必须人工确认;
 * - 普通写操作(写 SQL、非只读 shell 命令)ask 但不置 hard(never 可放行)。
 */
import { describe, expect, it } from 'vitest'
import { classifyStarHubCall } from '../src/index.ts'

/** 断言 ssh/docker 命令判为放行。 */
function allow(tool: string, command: string): void {
  expect(classifyStarHubCall(tool, { command })).toEqual({ ask: false })
}

/** 断言删除/高危档:ask 且 hard=true(即使 never 策略也必须确认)。 */
function askHard(tool: string, command: string, reasonPart: string): void {
  const verdict = classifyStarHubCall(tool, { command })
  expect(verdict?.ask).toBe(true)
  expect(verdict?.hard).toBe(true)
  if (verdict?.reason !== undefined) expect(verdict.reason).toContain(reasonPart)
  else throw new Error(`expected a risk reason containing ${reasonPart}`)
}

describe('ssh_exec risk gate', () => {
  it('allows read-only commands from the allowlist', () => {
    allow('ssh_exec', 'ls -la /var/log')
    allow('ssh_exec', 'ps aux | head')
    allow('ssh_exec', 'docker ps')
    allow('ssh_exec', 'cat /etc/os-release')
    allow('ssh_exec', 'find . -name "*.log"')
  })

  it('asks for plain destructive commands (hard tier)', () => {
    askHard('ssh_exec', 'rm -rf /tmp/x', 'rm -rf')
    askHard('ssh_exec', 'dd if=/dev/zero of=/dev/sda', 'dd 命令会覆写磁盘')
    askHard('ssh_exec', 'reboot', '重启命令')
  })

  it('asks for a plain rm file (soft: not a risk-pattern hit but not read-only)', () => {
    const verdict = classifyStarHubCall('ssh_exec', { command: 'rm file.txt' })
    expect(verdict?.ask).toBe(true)
    expect(verdict?.hard).toBeUndefined()
  })

  it('asks (soft) for unknown non-readonly commands', () => {
    const verdict = classifyStarHubCall('ssh_exec', { command: 'touch /etc/newfile' })
    expect(verdict?.ask).toBe(true)
    expect(verdict?.hard).toBeUndefined()
  })

  it('asks for the real-world multi-command cleanup that ran without confirmation', () => {
    // 用户实拍:AI 在 SSH 上未经确认执行了含两个 rm -rf 的清理命令。
    const command = 'echo "=== 删除前磁盘 ==="; df -h /root/autodl-tmp | tail -1; '
      + 'rm -rf /root/autodl-tmp/ComfyUI-2/output/minimax_seg_cache/5 && echo "已删除采样缓存"; '
      + 'rm -rf /root/autodl-tmp/ComfyUI/output/* && echo "已清理旧实例 output"; '
      + 'echo "=== 删除后磁盘 ==="; df -h /root/autodl-tmp | tail -1'
    const verdict = classifyStarHubCall('ssh_exec', { command })
    expect(verdict?.ask).toBe(true)
    expect(verdict?.hard).toBe(true)
    if (verdict?.reason !== undefined) expect(verdict.reason).toContain('rm -rf 删除系统目录')
    else throw new Error('expected the rm -rf risk reason')
  })

  it('asks for find -delete / -exec despite find being an allowlist prefix (SSH hardening)', () => {
    askHard('ssh_exec', 'find /var/www -name "*.tmp" -delete', 'find -delete/-exec 删除或执行')
    askHard('ssh_exec', 'find . -exec rm {} \\;', 'find -delete/-exec 删除或执行')
    askHard('ssh_exec', "find . -type f -execdir grep -l secret {} +", 'find -delete/-exec 删除或执行')
  })

  it('asks for ip network mutations despite ip being an allowlist prefix', () => {
    askHard('ssh_exec', 'ip link del eth0', 'ip 网络配置变更/删除')
    askHard('ssh_exec', 'ip addr flush dev eth0', 'ip 网络配置变更/删除')
    askHard('ssh_exec', 'ip route add default via 1.2.3.4', 'ip 网络配置变更/删除')
    allow('ssh_exec', 'ip addr show')
  })

  it('asks for journalctl vacuum/rotate but allows viewing', () => {
    askHard('ssh_exec', 'journalctl --vacuum-time=1s', 'journalctl 清理/滚动日志')
    askHard('ssh_exec', 'journalctl --rotate', 'journalctl 清理/滚动日志')
    allow('ssh_exec', 'journalctl -u nginx --no-pager -n 50')
  })
})

describe('docker_exec risk gate', () => {
  it('allows read-only docker inspection', () => {
    allow('docker_exec', 'docker ps')
    allow('docker_exec', 'docker images')
    allow('docker_exec', 'docker logs web-1 --tail 20')
  })

  it('asks for docker deletes in every form (hard rule)', () => {
    askHard('docker_exec', 'docker rm web-1', 'rm')
    askHard('docker_exec', 'docker rm -f web-1', 'rm')
    askHard('docker_exec', 'docker rmi -f app:1.0', 'docker rmi -f 强制删除镜像')
    askHard('docker_exec', 'docker system prune -a', 'docker system prune -a 删除所有未使用资源')
    askHard('docker_exec', 'docker image prune', 'docker prune 清理删除资源')
    askHard('docker_exec', 'docker volume rm pgdata', 'docker volume rm 删除数据卷')
    askHard('docker_exec', 'docker network rm vlan01', 'docker network rm 删除网络')
    askHard('docker_exec', 'docker compose down', 'docker compose 删除容器/编排')
    askHard('docker_exec', 'docker compose rm -f', 'rm')
  })

  it('asks but does not hard-flag a container start/stop write', () => {
    const verdict = classifyStarHubCall('docker_exec', { command: 'docker restart web-1' })
    expect(verdict?.ask).toBe(true)
    expect(verdict?.hard).toBeUndefined()
  })
})

describe('db_query gate', () => {
  it('allows read-only SQL', () => {
    expect(classifyStarHubCall('db_query', { sql: 'SELECT * FROM users LIMIT 10' })).toEqual({ ask: false })
  })

  it('hard-flags DROP/TRUNCATE and unconditional DELETE', () => {
    const drop = classifyStarHubCall('db_query', { sql: 'DROP TABLE users' })
    expect(drop?.ask).toBe(true)
    expect(drop?.hard).toBe(true)
    const truncate = classifyStarHubCall('db_query', { sql: 'TRUNCATE TABLE logs' })
    expect(truncate?.hard).toBe(true)
  })

  it('asks but does not hard-flag a plain write SQL', () => {
    const insert = classifyStarHubCall('db_query', { sql: 'INSERT INTO users(name) VALUES (1)' })
    expect(insert?.ask).toBe(true)
    expect(insert?.hard).toBeUndefined()
  })
})

describe('redis_exec gate', () => {
  it('allows read-only commands and hard-flags DEL/FLUSH', () => {
    expect(classifyStarHubCall('redis_exec', { command: 'GET user:1' })).toEqual({ ask: false })
    const del = classifyStarHubCall('redis_exec', { command: 'DEL user:1' })
    expect(del?.ask).toBe(true)
    expect(del?.hard).toBe(true)
    if (del?.reason !== undefined) expect(del.reason).toContain('删除 Redis 数据')
    const flush = classifyStarHubCall('redis_exec', { command: 'FLUSHDB' })
    expect(flush?.hard).toBe(true)
  })

  it('asks but does not hard-flag a plain write command', () => {
    const set = classifyStarHubCall('redis_exec', { command: 'SET key value' })
    expect(set?.ask).toBe(true)
    expect(set?.hard).toBeUndefined()
  })
})