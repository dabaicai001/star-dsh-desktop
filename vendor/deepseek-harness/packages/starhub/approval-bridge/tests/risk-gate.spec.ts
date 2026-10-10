/**
 * starhub-approval-bridge 风险门(防误删核心):`classifyStarHubCall` 对
 * ssh_exec / docker_exec 的只读放行与风险升级。本文件钉死两侧边界:
 * - 只读放行:ls / ps / find 纯列举 / docker ps 等;
 * - 风险升级:rm(-rf)、find -delete/-exec、ip link del、journalctl --vacuum、
 *   docker rm/rmi/prune/compose down、DROP/TRUNCATE、Redis DEL 等删除类命令
 *   一律 ask(v0.106.1 起会话策略恒 ask 的事故见 docs/踩坑记录.md §32);
 * - 普通写操作(写 SQL、非只读 shell 命令)同样 ask。
 *
 * 门只产出 ask,**是否真的弹卡由会话审批策略决定**:策略 never(完全权限)时
 * dsh-user-approval 先于所有 answerer 直接拒,门因此直接放行、不制造注定被驳回
 * 的 ask。该接线语义由 permission-policy.spec.ts 覆盖;原「hard 死规定」档
 * 已随「完全尊重 dsh 预设」下线(与 never 语义不可兼得)。
 */
import { describe, expect, it } from 'vitest'
import { classifyStarHubCall } from '../src/index.ts'

/** 断言 ssh/docker 命令判为放行。 */
function allow(tool: string, command: string): void {
  expect(classifyStarHubCall(tool, { command })).toEqual({ ask: false })
}

/** 断言命令升级为 ask,且原因命中给定文案片段。 */
function ask(tool: string, command: string, reasonPart: string): void {
  const verdict = classifyStarHubCall(tool, { command })
  expect(verdict?.ask).toBe(true)
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

  it('asks for destructive commands with their risk reason', () => {
    ask('ssh_exec', 'rm -rf /tmp/x', 'rm -rf')
    ask('ssh_exec', 'dd if=/dev/zero of=/dev/sda', 'dd 命令会覆写磁盘')
    ask('ssh_exec', 'reboot', '重启命令')
  })

  it('asks for a plain rm file (not a risk-pattern hit but not read-only)', () => {
    const verdict = classifyStarHubCall('ssh_exec', { command: 'rm file.txt' })
    expect(verdict?.ask).toBe(true)
    expect(verdict?.reason).toBe('非只读命令,需要确认')
  })

  it('asks for unknown non-readonly commands', () => {
    const verdict = classifyStarHubCall('ssh_exec', { command: 'touch /etc/newfile' })
    expect(verdict?.ask).toBe(true)
    expect(verdict?.reason).toBe('非只读命令,需要确认')
  })

  it('asks for the real-world multi-command cleanup that ran without confirmation', () => {
    // 用户实拍:AI 在 SSH 上未经确认执行了含两个 rm -rf 的清理命令。
    const command = 'echo "=== 删除前磁盘 ==="; df -h /root/autodl-tmp | tail -1; '
      + 'rm -rf /root/autodl-tmp/ComfyUI-2/output/minimax_seg_cache/5 && echo "已删除采样缓存"; '
      + 'rm -rf /root/autodl-tmp/ComfyUI/output/* && echo "已清理旧实例 output"; '
      + 'echo "=== 删除后磁盘 ==="; df -h /root/autodl-tmp | tail -1'
    const verdict = classifyStarHubCall('ssh_exec', { command })
    expect(verdict?.ask).toBe(true)
    if (verdict?.reason !== undefined) expect(verdict.reason).toContain('rm -rf 删除系统目录')
    else throw new Error('expected the rm -rf risk reason')
  })

  it('asks for find -delete / -exec despite find being an allowlist prefix (SSH hardening)', () => {
    ask('ssh_exec', 'find /var/www -name "*.tmp" -delete', 'find -delete/-exec 删除或执行')
    ask('ssh_exec', 'find . -exec rm {} \\;', 'find -delete/-exec 删除或执行')
    ask('ssh_exec', 'find . -type f -execdir grep -l secret {} +', 'find -delete/-exec 删除或执行')
  })

  it('asks for ip network mutations despite ip being an allowlist prefix', () => {
    ask('ssh_exec', 'ip link del eth0', 'ip 网络配置变更/删除')
    ask('ssh_exec', 'ip addr flush dev eth0', 'ip 网络配置变更/删除')
    ask('ssh_exec', 'ip route add default via 1.2.3.4', 'ip 网络配置变更/删除')
    allow('ssh_exec', 'ip addr show')
  })

  it('asks for journalctl vacuum/rotate but allows viewing', () => {
    ask('ssh_exec', 'journalctl --vacuum-time=1s', 'journalctl 清理/滚动日志')
    ask('ssh_exec', 'journalctl --rotate', 'journalctl 清理/滚动日志')
    allow('ssh_exec', 'journalctl -u nginx --no-pager -n 50')
  })
})

describe('docker_exec risk gate', () => {
  it('allows read-only docker inspection', () => {
    allow('docker_exec', 'docker ps')
    allow('docker_exec', 'docker images')
    allow('docker_exec', 'docker logs web-1 --tail 20')
  })

  it('asks for docker deletes in every form', () => {
    ask('docker_exec', 'docker rm web-1', 'rm')
    ask('docker_exec', 'docker rm -f web-1', 'rm')
    ask('docker_exec', 'docker rmi -f app:1.0', 'docker rmi -f 强制删除镜像')
    ask('docker_exec', 'docker system prune -a', 'docker system prune -a 删除所有未使用资源')
    ask('docker_exec', 'docker image prune', 'docker prune 清理删除资源')
    ask('docker_exec', 'docker volume rm pgdata', 'docker volume rm 删除数据卷')
    ask('docker_exec', 'docker network rm vlan01', 'docker network rm 删除网络')
    ask('docker_exec', 'docker compose down', 'docker compose 删除容器/编排')
    ask('docker_exec', 'docker compose rm -f', 'rm')
  })

  it('asks for a container start/stop write', () => {
    const verdict = classifyStarHubCall('docker_exec', { command: 'docker restart web-1' })
    expect(verdict?.ask).toBe(true)
    expect(verdict?.reason).toBe('非只读命令,需要确认')
  })
})

describe('db_query gate', () => {
  it('allows read-only SQL', () => {
    expect(classifyStarHubCall('db_query', { sql: 'SELECT * FROM users LIMIT 10' })).toEqual({ ask: false })
  })

  it('asks for DROP/TRUNCATE and unconditional DELETE', () => {
    const drop = classifyStarHubCall('db_query', { sql: 'DROP TABLE users' })
    expect(drop?.ask).toBe(true)
    if (drop?.reason !== undefined) expect(drop.reason).toContain('DROP 数据库对象')
    else throw new Error('expected the DROP risk reason')
    expect(classifyStarHubCall('db_query', { sql: 'TRUNCATE TABLE logs' })?.ask).toBe(true)
  })

  it('asks for a plain write SQL', () => {
    const insert = classifyStarHubCall('db_query', { sql: 'INSERT INTO users(name) VALUES (1)' })
    expect(insert?.ask).toBe(true)
    expect(insert?.reason).toBe('写 SQL,需要确认')
  })
})

describe('redis_exec gate', () => {
  it('allows read-only commands and asks for DEL/FLUSH', () => {
    expect(classifyStarHubCall('redis_exec', { command: 'GET user:1' })).toEqual({ ask: false })
    const del = classifyStarHubCall('redis_exec', { command: 'DEL user:1' })
    expect(del?.ask).toBe(true)
    if (del?.reason !== undefined) expect(del.reason).toContain('删除 Redis 数据')
    else throw new Error('expected the Redis delete reason')
    expect(classifyStarHubCall('redis_exec', { command: 'FLUSHDB' })?.ask).toBe(true)
  })

  it('asks for a plain write command', () => {
    const set = classifyStarHubCall('redis_exec', { command: 'SET key value' })
    expect(set?.ask).toBe(true)
    expect(set?.reason).toBe('写 Redis 命令,需要确认')
  })
})

describe('desktop_* gate(沙箱桌面,已整体删除)', () => {
  it('desktop_* 工具已整体删除,风险门一律返回 null(不再介入)', () => {
    expect(classifyStarHubCall('desktop_exec', { command: 'ls' })).toBeNull()
    expect(classifyStarHubCall('desktop_create_sandbox', { template: 'ubuntu-desktop' })).toBeNull()
    expect(classifyStarHubCall('desktop_nope', {})).toBeNull()
  })
})

describe('android_* gate(实体机,任务级授权)', () => {
  it('android: connect/open_live 确认,exec/传输/无线确认,感知/操作放行', () => {
    for (const tool of ['android_connect', 'android_open_live']) {
      expect(classifyStarHubCall(tool, {})?.ask, tool).toBe(true)
    }
    // 实体机任意 shell:恒确认(never 策略下由策略层放行,见 permission-policy.spec.ts)
    expect(classifyStarHubCall('android_exec', { command: 'pm list packages' })?.ask).toBe(true)
    for (const tool of ['android_pull', 'android_push', 'android_wireless']) {
      expect(classifyStarHubCall(tool, {})?.ask, tool).toBe(true)
    }
    // 授权内感知/操作:门放行(授权与接管互斥由宿主在执行点强制)
    for (const tool of [
      'android_list_devices', 'android_disconnect', 'android_device_status',
      'android_replay', 'android_screenshot', 'android_current_app',
      'android_tap', 'android_double_tap', 'android_swipe', 'android_scroll',
      'android_type', 'android_press_key', 'android_launch_app',
    ]) {
      expect(classifyStarHubCall(tool, {}), tool).toEqual({ ask: false })
    }
    expect(classifyStarHubCall('android_nope', {})).toBeNull()
  })
})
