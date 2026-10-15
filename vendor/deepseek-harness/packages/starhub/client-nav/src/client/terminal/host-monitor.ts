/**
 * 主机监控(SSH 终端「监控」页签):在已有 SSH 会话上跑一条只读采集命令,
 * 把分段输出解析成指标模型。
 *
 * 命令刻意保持 POSIX + busybox 兼容(容器 / Alpine 也能跑),并且只用
 * `2>/dev/null` 容错——任何一段缺失都只让对应指标为 null,不影响其它段。
 * 采集走 `ui.ssh_exec`(已有会话上的一条 exec,不新开连接),因此面板刷新
 * 不会在终端里留下可见输出。
 *
 * @module StarHub SSH host monitor (client)
 */

/** 一条分区用量。 */
export interface HostDisk {
  fs: string
  size: string
  used: string
  avail: string
  /** 已用百分比(0-100),解析失败为 0。 */
  percent: number
  mount: string
}

/** 解析后的主机指标(缺失段为 null)。 */
export interface HostMetrics {
  hostname: string | null
  kernel: string | null
  /** 运行时长原文(优先 /proc/uptime 算出的可读值,否则 uptime 原文截取)。 */
  uptime: string | null
  /** 1 / 5 / 15 分钟负载。 */
  load: [number, number, number] | null
  mem: { totalMb: number; usedMb: number; freeMb: number; percent: number } | null
  disks: HostDisk[]
  cpuCores: number | null
  /** 全网卡(不含 lo)累计收 / 发字节。 */
  net: { rxBytes: number; txBytes: number } | null
  procs: number | null
}

/** 分段标记:每段一行,便于按段解析。 */
const SECTION_HOST = '@@HOST'
const SECTION_UPTIME = '@@UPTIME'
const SECTION_LOAD = '@@LOAD'
const SECTION_MEM = '@@MEM'
const SECTION_DISK = '@@DISK'
const SECTION_CPU = '@@CPU'
const SECTION_NET = '@@NET'
const SECTION_PS = '@@PS'

/** 主机指标采集命令(只读;单条 exec,一次拿全)。 */
export const HOST_METRICS_COMMAND = [
  `echo '${SECTION_HOST}'; hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null; uname -sr 2>/dev/null`,
  `echo '${SECTION_UPTIME}'; uptime 2>/dev/null; cat /proc/uptime 2>/dev/null`,
  `echo '${SECTION_LOAD}'; cat /proc/loadavg 2>/dev/null`,
  `echo '${SECTION_MEM}'; free -m 2>/dev/null | sed -n '2p'; grep -E '^(MemTotal|MemAvailable|MemFree):' /proc/meminfo 2>/dev/null`,
  `echo '${SECTION_DISK}'; df -hP 2>/dev/null | sed 1d`,
  `echo '${SECTION_CPU}'; nproc 2>/dev/null; grep -c '^processor' /proc/cpuinfo 2>/dev/null`,
  `echo '${SECTION_NET}'; cat /proc/net/dev 2>/dev/null`,
  `echo '${SECTION_PS}'; ls -1 /proc 2>/dev/null | grep -c '^[0-9]'`,
].join('; ')

/** 空指标(全部缺失)。 */
function emptyMetrics(): HostMetrics {
  return {
    hostname: null, kernel: null, uptime: null, load: null, mem: null,
    disks: [], cpuCores: null, net: null, procs: null,
  }
}

/**
 * 把采集输出按段切分。
 * @param raw - `ssh_exec` 的完整 stdout。
 * @returns 段名 → 该段的行(标记行之后的非空行)。
 */
function splitSections(raw: string): Map<string, string[]> {
  const sections = new Map<string, string[]>()
  let current: string | null = null
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('@@')) {
      current = trimmed
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (current === null || trimmed === '') continue
    sections.get(current)?.push(trimmed)
  }
  return sections
}

/** 解析运行时长:/proc/uptime 秒数优先,否则把 uptime 的 up 片段折算成秒。 */
function parseUptime(lines: readonly string[]): string | null {
  const seconds = lines[0]?.match(/^(\d+(?:\.\d+)?)\s/)
  if (seconds?.[1] !== undefined) return formatSeconds(Number(seconds[1]))
  const uptimeLine = lines.find(line => line.includes('up '))
  if (uptimeLine === undefined) return null
  const start = uptimeLine.indexOf('up ')
  const loadAt = uptimeLine.indexOf('load average')
  const text = uptimeLine.slice(start, loadAt === -1 ? undefined : loadAt).trim().replace(/,\s*$/, '')
  // `up 5 days,  3:12` / `up 3:12` / `up 12 min` → 秒数,再走同一套可读格式化。
  const days = Number(text.match(/(\d+)\s+day/)?.[1] ?? 0)
  const clock = text.match(/(\d+):(\d{2})/)
  const minutes = Number(text.match(/(\d+)\s*min/)?.[1] ?? 0)
  if (days > 0 || clock !== null || minutes > 0) {
    const total = days * 86400 + Number(clock?.[1] ?? 0) * 3600 + Number(clock?.[2] ?? 0) * 60 + minutes * 60
    return formatSeconds(total)
  }
  return text
}

/**
 * 秒数转可读时长。
 * @param totalSeconds - 秒数。
 * @returns 例如 `5天3小时12分` / `3小时12分` / `12分`。
 */
export function formatSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天${hours}小时${minutes}分`
  if (hours > 0) return `${hours}小时${minutes}分`
  return `${minutes}分`
}

/** 解析内存段:`free -m` 第二行优先,缺失时退回 /proc/meminfo。 */
function parseMem(lines: readonly string[]): HostMetrics['mem'] {
  const freeLine = lines.find(line => /^Mem:/.test(line))
  if (freeLine !== undefined) {
    const fields = freeLine.split(/\s+/)
    const totalMb = Number(fields[1])
    const usedMb = Number(fields[2])
    const freeMb = Number(fields[3])
    if (Number.isFinite(totalMb) && totalMb > 0) {
      const percent = Math.round((usedMb / totalMb) * 100)
      return { totalMb, usedMb, freeMb, percent: Number.isFinite(percent) ? percent : 0 }
    }
  }
  let totalKb: number | null = null
  let availableKb: number | null = null
  let freeKb: number | null = null
  for (const line of lines) {
    const match = line.match(/^Mem(?:Total|Available|Free):\s+(\d+)\s+kB/i)
    const value = match?.[1]
    if (value === undefined) continue
    if (/^MemTotal/i.test(line)) totalKb = Number(value)
    else if (/^MemAvailable/i.test(line)) availableKb = Number(value)
    else freeKb = Number(value)
  }
  if (totalKb === null || totalKb <= 0) return null
  const totalMb = Math.round(totalKb / 1024)
  const freeMb = freeKb === null ? 0 : Math.round(freeKb / 1024)
  const usedMb = availableKb === null ? totalMb - freeMb : totalMb - Math.round(availableKb / 1024)
  return { totalMb, usedMb, freeMb, percent: Math.round((usedMb / totalMb) * 100) }
}

/** 解析磁盘段:`df -hP` 行(挂载点含空格时拼回尾部)。 */
function parseDisks(lines: readonly string[]): HostDisk[] {
  const disks: HostDisk[] = []
  for (const line of lines) {
    const fields = line.split(/\s+/)
    if (fields.length < 6) continue
    const [fs = '', size = '', used = '', avail = '', percentText = ''] = fields
    disks.push({
      fs, size, used, avail,
      percent: Number.parseInt(percentText, 10) || 0,
      mount: fields.slice(5).join(' '),
    })
  }
  return disks
}

/** 解析网卡段:累计各网卡(不含 lo)的收 / 发字节。 */
function parseNet(lines: readonly string[]): HostMetrics['net'] {
  let rxBytes = 0
  let txBytes = 0
  let seen = false
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const iface = line.slice(0, colon).trim()
    if (iface === '' || iface === 'lo') continue
    const fields = line.slice(colon + 1).trim().split(/\s+/)
    const rx = Number(fields[0])
    const tx = Number(fields[8])
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue
    rxBytes += rx
    txBytes += tx
    seen = true
  }
  return seen ? { rxBytes, txBytes } : null
}

/** 取段内第一个正整数。 */
function firstPositiveInt(lines: readonly string[]): number | null {
  for (const line of lines) {
    const value = Number.parseInt(line, 10)
    if (Number.isFinite(value) && value > 0) return value
  }
  return null
}

/**
 * 解析主机指标采集输出。
 * @param raw - `ssh_exec` 返回的 stdout。
 * @returns 指标模型(缺失段为 null / 空数组)。
 */
export function parseHostMetrics(raw: string): HostMetrics {
  const sections = splitSections(raw)
  const metrics = emptyMetrics()
  const host = sections.get(SECTION_HOST)
  if (host !== undefined && host.length > 0) {
    metrics.hostname = host[0] ?? null
    metrics.kernel = host[1] ?? null
  }
  const uptime = sections.get(SECTION_UPTIME)
  if (uptime !== undefined) metrics.uptime = parseUptime(uptime)
  const load = sections.get(SECTION_LOAD)?.[0]?.split(/\s+/).slice(0, 3).map(Number)
  if (load !== undefined && load.length === 3 && load.every(value => Number.isFinite(value))) {
    metrics.load = [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0]
  }
  const mem = sections.get(SECTION_MEM)
  if (mem !== undefined) metrics.mem = parseMem(mem)
  const disk = sections.get(SECTION_DISK)
  if (disk !== undefined) metrics.disks = parseDisks(disk)
  const cpu = sections.get(SECTION_CPU)
  if (cpu !== undefined) metrics.cpuCores = firstPositiveInt(cpu)
  const net = sections.get(SECTION_NET)
  if (net !== undefined) metrics.net = parseNet(net)
  const ps = sections.get(SECTION_PS)
  if (ps !== undefined) metrics.procs = firstPositiveInt(ps)
  return metrics
}

/** 字节数转可读大小(B/KB/MB/GB/TB,一位小数)。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exponent
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}
