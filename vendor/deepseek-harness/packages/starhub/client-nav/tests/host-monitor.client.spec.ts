/**
 * 主机指标解析(host-monitor.ts):分段切割、uptime 两种来源折算、内存
 * free/meminfo 两条路径、磁盘表(挂载点含空格)、网卡累计、缺段降级为 null。
 */
import { describe, expect, it } from 'vitest'
import {
  formatBytes, formatSeconds, HOST_METRICS_COMMAND, parseHostMetrics,
} from '../src/client/terminal/host-monitor.ts'

/** 拼一段带标记的采集输出。 */
function raw(sections: Record<string, string[]>): string {
  return Object.entries(sections)
    .flatMap(([marker, lines]) => [marker, ...lines])
    .join('\n')
}

describe('parseHostMetrics', () => {
  it('parses every section of a Linux host', () => {
    const metrics = parseHostMetrics(raw({
      '@@HOST': ['web-01', 'Linux 5.15.0-86-generic'],
      '@@UPTIME': ['443520.12 890123.00'],
      '@@LOAD': ['0.20 0.15 0.05 1/234 5678'],
      '@@MEM': ['Mem:  8000  2000  4000  100  2000  6000'],
      '@@DISK': ['/dev/vda1  50G  20G  30G  40% /', 'tmpfs  100M  0  100M  0% /run/lock'],
      '@@CPU': ['8'],
      '@@NET': ['  eth0: 1024 10 0 0 0 0 0 0 2048 20 0 0 0 0 0 0', '    lo: 99 1 0 0 0 0 0 0 99 1 0 0 0 0 0 0'],
      '@@PS': ['128'],
    }))
    expect(metrics.hostname).toBe('web-01')
    expect(metrics.kernel).toBe('Linux 5.15.0-86-generic')
    expect(metrics.uptime).toBe('5天3小时12分')
    expect(metrics.load).toEqual([0.2, 0.15, 0.05])
    expect(metrics.mem).toEqual({ totalMb: 8000, usedMb: 2000, freeMb: 4000, percent: 25 })
    expect(metrics.disks).toEqual([
      { fs: '/dev/vda1', size: '50G', used: '20G', avail: '30G', percent: 40, mount: '/' },
      { fs: 'tmpfs', size: '100M', used: '0', avail: '100M', percent: 0, mount: '/run/lock' },
    ])
    expect(metrics.cpuCores).toBe(8)
    // lo 不计入累计
    expect(metrics.net).toEqual({ rxBytes: 1024, txBytes: 2048 })
    expect(metrics.procs).toBe(128)
  })

  it('falls back to the uptime text when /proc/uptime is missing', () => {
    const metrics = parseHostMetrics(raw({
      '@@UPTIME': [' 09:00:00 up 5 days,  3:12,  2 users,  load average: 0.20, 0.15, 0.05'],
    }))
    expect(metrics.uptime).toBe('5天3小时12分')
  })

  it('keeps the raw uptime text when no duration can be derived', () => {
    expect(parseHostMetrics(raw({ '@@UPTIME': ['weird output'] })).uptime).toBeNull()
    expect(parseHostMetrics(raw({ '@@UPTIME': ['up since forever'] })).uptime).toBe('up since forever')
  })

  it('derives memory from /proc/meminfo when free is unavailable', () => {
    const metrics = parseHostMetrics(raw({
      '@@MEM': ['MemTotal:       16384000 kB', 'MemAvailable:    12288000 kB', 'MemFree:         4096000 kB'],
    }))
    expect(metrics.mem).toEqual({ totalMb: 16000, usedMb: 4000, freeMb: 4000, percent: 25 })
  })

  it('returns null metrics for missing or unusable sections', () => {
    const metrics = parseHostMetrics(raw({
      '@@HOST': ['busybox'],
      '@@MEM': ['Mem:  n/a'],
      '@@DISK': ['too few fields'],
      '@@NET': ['  eth0: bad'],
      '@@CPU': ['0'],
      '@@PS': [],
    }))
    expect(metrics.hostname).toBe('busybox')
    expect(metrics.kernel).toBeNull()
    expect(metrics.uptime).toBeNull()
    expect(metrics.load).toBeNull()
    expect(metrics.mem).toBeNull()
    expect(metrics.disks).toEqual([])
    expect(metrics.net).toBeNull()
    expect(metrics.cpuCores).toBeNull()
    expect(metrics.procs).toBeNull()
  })

  it('handles empty output', () => {
    const metrics = parseHostMetrics('')
    expect(metrics).toEqual({
      hostname: null, kernel: null, uptime: null, load: null, mem: null,
      disks: [], cpuCores: null, net: null, procs: null,
    })
  })

  it('builds a read-only collection command with all section markers', () => {
    for (const marker of ['@@HOST', '@@UPTIME', '@@LOAD', '@@MEM', '@@DISK', '@@CPU', '@@NET', '@@PS']) {
      expect(HOST_METRICS_COMMAND).toContain(marker)
    }
    // 只读采集:不出现任何写操作
    expect(HOST_METRICS_COMMAND).not.toMatch(/\b(rm|mv|dd|mkfs|kill|reboot|shutdown)\b/)
  })
})

describe('formatSeconds / formatBytes', () => {
  it('formats durations at each scale', () => {
    expect(formatSeconds(0)).toBe('0分')
    expect(formatSeconds(720)).toBe('12分')
    expect(formatSeconds(11160)).toBe('3小时6分')
    expect(formatSeconds(443520)).toBe('5天3小时12分')
    expect(formatSeconds(-5)).toBe('0分')
  })

  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1024 ** 3 * 1.5)).toBe('1.5 GB')
  })
})
