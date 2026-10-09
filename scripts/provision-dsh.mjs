#!/usr/bin/env node
/**
 * StarHub × dsh desktop provisioning(去 Tauri 化 M4 第 1 步)。
 *
 * Tauri 壳退役后,「把 StarHub 组合装进 dsh」这件事原来由 Rust 主进程在启动时
 * 做(`src-tauri/src/harness/web.rs`:物化 profile、junction 本地包、改写
 * webserver 端口、spawn 便携 node)。壳换成上游 Electron 之后没有 Rust 主进程
 * 了,同样的活由本脚本在**安装后 / 首次启动前**做一次:
 *
 * 1. 物化 `$DSH_HOME/profiles/<profile>/`——`package.json`(manifest,含
 *    `dsh.profile.bundles`)、`cordis.patch.yml`、`pnpm-workspace.yaml`
 *    (上游 `initProfile` 的同款三件套,不跑包管理器);
 * 2. 把 10 个 StarHub 包(9 插件 + bridge)的**运行时段**拷进
 *    `<profile>/node_modules/@deepseek-ai/<name>`——装完就不依赖构建树;
 * 3. 把部署变化项按 id **行级幂等合并**进 `cordis.patch.yml`:
 *    `webserver` 的 host/port、`starhub-bridge` 的 `sidecarCommand`、
 *    `starhub-host-static` 的 `windowDist`。用户经 GUI 设置面板写进同一文件
 *    的行一律保留——整体覆盖会把用户设置全重置(v0.122.0 回归);
 * 4. 把两个 sidecar 二进制与 React 工作台 dist 落到
 *    `<home>/starhub/resources/`,供上一行的绝对路径引用;
 * 5. 写一份 `<home>/starhub/provision.json` 清单(物化了什么、什么版本),
 *    重跑时据此发现漂移并刷新。
 *
 * 为什么不 junction 而拷贝:Rust 侧 junction 指向构建树,升级/换安装目录会让
 * 旧 junction 钉死上一次的路径(漂移),要额外写 `ensure_dir_link_fresh` 兜底。
 * 安装形态下包本来就要随安装包走,拷贝没有目标可漂移;重跑时按清单比对,
 * 内容变了就地刷新。
 *
 * 用法:
 *   node scripts/provision-dsh.mjs --home <DSH_HOME> [--profile desktop]
 *     [--vendor <vendorRoot>] [--resources <dir>]
 *     [--sidecar-rust <path>] [--sidecar-go <path>] [--window-dist <dir>]
 *     [--port <n>] [--host <addr>] [--dry-run]
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergePatchRows, rowsFromTemplate, validProfileName, webserverRow } from './lib/provision-patch.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 物化进 profile 的 StarHub 包(packages/starhub/ 下目录名)。
 *  与 Rust web.rs 的 LOCAL_PACKAGES + bridge 对齐;漏列即安装包启动
 *  ERR_MODULE_NOT_FOUND(v0.92.2 同类事故)。 */
const STARHUB_PACKAGES = [
  'client-nav',
  'host-static',
  'tool-context',
  'bridge',
  'tools',
  'approval-bridge',
  'session-registry',
  'domain-events',
  'live-context',
  'commit-message',
]

/** 每个包要拷贝进 profile 的运行时段(构建产物 + manifest)。 */
const PACKAGE_COPY_ENTRIES = ['package.json', 'lib']

/** profile manifest 的初始 bundle 层(上游 `PROFILE_TEMPLATES.web`)。 */
const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** provisioning 负责维护的 patch 行 id(其余行一律视为用户/上游所有)。 */
const MANAGED_PATCH_IDS = ['webserver', 'starhub-bridge', 'starhub-host-static']

/** 物化清单的文件名(重跑据此发现漂移)。 */
const PROVISION_MANIFEST = 'provision.json'

/** patch 模板里由 provisioning 填值的占位符。 */
const PLACEHOLDERS = {
  windowDist: '@@STARHUB_WINDOW_DIST@@',
  sidecarCommand: '@@STARHUB_SIDECAR_COMMAND@@',
}

/** CLI 参数(缺省值面向仓库内开发布局;安装形态由安装脚本显式传全)。 */
const DEFAULTS = {
  home: join(repoRoot, 'tmp', 'dsh-desktop-home'),
  profile: 'desktop',
  vendor: join(repoRoot, 'vendor', 'deepseek-harness'),
  resources: null,
  sidecarRust: null,
  sidecarGo: null,
  windowDist: join(repoRoot, 'dist-starhub-react'),
  host: '127.0.0.1',
  port: 0,
  dryRun: false,
}

function parseArgs(argv) {
  const values = { ...DEFAULTS }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} 需要一个值`)
      }
      return value
    }
    switch (arg) {
      case '--home': values.home = next(); break
      case '--profile': values.profile = next(); break
      case '--vendor': values.vendor = next(); break
      case '--resources': values.resources = next(); break
      case '--sidecar-rust': values.sidecarRust = next(); break
      case '--sidecar-go': values.sidecarGo = next(); break
      case '--window-dist': values.windowDist = next(); break
      case '--host': values.host = next(); break
      case '--port': values.port = Number.parseInt(next(), 10); break
      case '--dry-run': values.dryRun = true; break
      case '--help': console.log(usage()); process.exit(0)
      default: throw new Error(`未知参数 ${arg}`)
    }
  }
  if (!Number.isInteger(values.port) || values.port < 0 || values.port > 65535) {
    throw new Error(`--port 必须是 0..65535 的整数,收到 ${values.port}`)
  }
  if (!validProfileName(values.profile)) {
    throw new Error(`--profile 非法: ${JSON.stringify(values.profile)}(上游 resolveProfileDir 同款白名单)`)
  }

  return values
}

function usage() {
  return [
    'Usage: node scripts/provision-dsh.mjs --home <DSH_HOME> [flags]',
    '',
    '  --home <dir>          DSH_HOME(profile 的父目录)。',
    '  --profile <name>      profile 名,缺省 desktop。',
    '  --vendor <dir>        vendor/deepseek-harness 根。',
    '  --resources <dir>     sidecar 与工作台 dist 的落地目录,缺省 <home>/starhub/resources。',
    '  --sidecar-rust <path> starhub-sidecar-rust 二进制(缺省构建输出)。',
    '  --sidecar-go <path>   starhub-sidecar-go 二进制(缺省构建输出)。',
    '  --window-dist <dir>   React 工作台 dist(缺省仓库 dist-starhub-react)。',
    '  --host <addr>         webserver 监听地址,缺省 127.0.0.1。',
    '  --port <n>            webserver 端口,缺省 0(内核分配空闲端口)。',
    '  --dry-run             只打印将要做的事,不落盘。',
    '',
  ].join('\n')
}

/** 侧车二进制的仓库内构建输出(开发布局;安装形态显式传路径)。 */
function defaultSidecarPaths(vendor) {
  const rustDebug = join(repoRoot, 'sidecar-rust', 'target', 'debug')
  const goBin = join(repoRoot, 'sidecar', 'bin')
  const windows = process.platform === 'win32'
  return {
    rust: join(rustDebug, windows ? 'starhub-sidecar-rust.exe' : 'starhub-sidecar-rust'),
    go: join(goBin, windows ? 'starhub-sidecar-go.exe' : 'starhub-sidecar-go'),
    vendor,
  }
}

async function pathKind(path) {
  try {
    const info = await stat(path)
    return info.isDirectory() ? 'dir' : 'file'
  } catch {
    return 'missing'
  }
}

/** 目录拷贝(递归),目标已存在则整目录替换。 */
async function copyDirFresh(source, target) {
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true })
}

/** 读模板 patch,把占位符换成实际值。 */
async function renderTemplate(templatePath, values) {
  const template = await readFile(templatePath, 'utf8')
  const rendered = template
    .replaceAll(PLACEHOLDERS.windowDist, values.windowDist)
    .replaceAll(PLACEHOLDERS.sidecarCommand, values.sidecarCommand)
  if (rendered.includes(PLACEHOLDERS.windowDist) || rendered.includes(PLACEHOLDERS.sidecarCommand)) {
    throw new Error(`patch 模板占位符未全部替换: ${templatePath}`)
  }
  return rendered
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const home = resolve(options.home)
  const profileDir = join(home, 'profiles', options.profile)
  const resources = resolve(options.resources ?? join(home, 'starhub', 'resources'))
  const vendor = resolve(options.vendor)
  const sidecars = options.sidecarRust !== null || options.sidecarGo !== null
    ? { rust: options.sidecarRust, go: options.sidecarGo, vendor }
    : defaultSidecarPaths(vendor)

  // ── 前置校验:缺一项就 fail loud,不物化半套 ──
  const problems = []
  for (const name of STARHUB_PACKAGES) {
    const kind = await pathKind(join(vendor, 'packages', 'starhub', name))
    if (kind !== 'dir') problems.push(`StarHub 包目录缺失: packages/starhub/${name}`)
  }
  const rustKind = await pathKind(sidecars.rust)
  if (rustKind !== 'file') problems.push(`sidecar-rust 二进制缺失: ${sidecars.rust}(先跑 npm run sidecar-rust:build)`)
  const goKind = await pathKind(sidecars.go)
  if (goKind !== 'file') problems.push(`sidecar-go 二进制缺失: ${sidecars.go}(先跑 npm run sidecar:build)`)
  const windowKind = await pathKind(options.windowDist)
  if (windowKind !== 'dir') problems.push(`React 工作台 dist 缺失: ${options.windowDist}(先跑 npm run build:window)`)
  const templatePath = join(vendor, 'examples', 'starhub-desktop', 'cordis.patch.yml')
  if (!existsSync(templatePath)) problems.push(`patch 模板缺失: ${templatePath}`)
  if (problems.length > 0) {
    console.error('provision-dsh: 前置校验失败:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  const plan = {
    home, profileDir, resources, sidecars, options,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    manifestPath: join(profileDir, 'package.json'),
    provisionManifestPath: join(home, 'starhub', PROVISION_MANIFEST),
    templatePath,
  }
  console.log('[provision-dsh] 物化计划:')
  console.log(`  DSH_HOME     ${home}`)
  console.log(`  profile      ${plan.profileDir}`)
  console.log(`  resources    ${resources}`)
  console.log(`  sidecar-rust ${sidecars.rust}`)
  console.log(`  sidecar-go   ${sidecars.go}`)
  console.log(`  window-dist  ${options.windowDist}`)
  console.log(`  webserver    ${options.host}:${options.port === 0 ? '(内核分配)' : options.port}`)
  console.log(`  包           ${STARHUB_PACKAGES.length} 个 → ${join(profileDir, 'node_modules', '@deepseek-ai')}`)
  if (options.dryRun) {
    console.log('[provision-dsh] --dry-run:不落盘')
    return
  }

  // ── 1. profile 三件套(已存在则不动,与上游 initProfile 同语义)──
  await mkdir(profileDir, { recursive: true })
  if (!existsSync(plan.manifestPath)) {
    await writeFile(plan.manifestPath, `${JSON.stringify({
      name: `dsh-profile-${options.profile}`,
      private: true,
      dependencies: {},
      'dsh': { profile: { bundles: [...PROFILE_BUNDLES] } },
    }, undefined, 2)}\n`)
    console.log('[provision-dsh] 写入 profile package.json')
  } else {
    const manifest = JSON.parse(await readFile(plan.manifestPath, 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    if (Array.isArray(bundles)) {
      const missing = PROFILE_BUNDLES.filter(bundle => !bundles.includes(bundle))
      if (missing.length > 0) {
        manifest.dsh.profile.bundles = [...bundles, ...missing]
        await writeFile(plan.manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
        console.log(`[provision-dsh] 补 bundle 层: ${missing.join(', ')}`)
      }
    }
  }
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    await writeFile(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    console.log('[provision-dsh] 写入 pnpm-workspace.yaml')
  }

  // ── 2. StarHub 包 → profile/node_modules/@deepseek-ai/<name> ──
  const packagesRoot = join(profileDir, 'node_modules', '@deepseek-ai')
  for (const name of STARHUB_PACKAGES) {
    const source = join(vendor, 'packages', 'starhub', name)
    const target = join(packagesRoot, `dsh-starhub-${name}`)
    // 只搬运行时段:manifest + lib/(host lib 与 client bundle 都在里面)。
    // 先清再拷,保证重跑会刷新而不是留下上一次的残留模块表。
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    for (const entry of PACKAGE_COPY_ENTRIES) {
      const from = join(source, entry)
      if (!existsSync(from)) continue
      if (entry === 'package.json') {
        await cp(from, join(target, entry))
        continue
      }
      await cp(from, join(target, entry), { recursive: true })
    }
  }
  console.log(`[provision-dsh] 落包 ${STARHUB_PACKAGES.length} 个 → ${packagesRoot}`)

  // ── 3. sidecar 二进制 + 工作台 dist → resources ──
  await mkdir(resources, { recursive: true })
  const rustTarget = join(resources, 'starhub-sidecar-rust')
  const goTarget = join(resources, 'starhub-sidecar-go')
  await copyDirFresh(sidecars.rust, rustTarget)
  await copyDirFresh(sidecars.go, goTarget)
  const windowTarget = join(resources, 'starhub-react')
  await copyDirFresh(options.windowDist, windowTarget)
  console.log(`[provision-dsh] 落资源 → ${resources}`)

  // ── 4. cordis.patch.yml:行级幂等合并 ──
  const sidecarCommand = JSON.stringify([rustTarget])
  const rendered = await renderTemplate(templatePath, {
    windowDist: windowTarget,
    sidecarCommand,
  })
  // webserver 行由本次调用参数构造(不取模板:模板里的 port 只是文档性缺省,
  // 从模板取会让 --port / --host 静默失效);另两行来自模板(占位符已替换)。
  const rows = [
    webserverRow(options.host, options.port),
    ...rowsFromTemplate(rendered, MANAGED_PATCH_IDS).filter(row => row.id !== 'webserver'),
  ]
  const existing = existsSync(plan.patchPath) ? await readFile(plan.patchPath, 'utf8') : ''
  // 首次物化:模板整体落地(注释与说明对用户可读);之后只按 id 合并受管行。
  const merged = existing === '' ? rendered : mergePatchRows(existing, rows)
  if (merged !== existing || !existsSync(plan.patchPath)) {
    await writeFile(plan.patchPath, merged)
    console.log(`[provision-dsh] ${existing === '' ? '写入' : '合并'} cordis.patch.yml(${rows.length} 个受管行)`)
  } else {
    console.log('[provision-dsh] cordis.patch.yml 已是最新,未改动')
  }

  // ── 5. 物化清单 ──
  await mkdir(dirname(plan.provisionManifestPath), { recursive: true })
  await writeFile(plan.provisionManifestPath, `${JSON.stringify({
    profile: options.profile,
    profileDir,
    resources,
    packages: STARHUB_PACKAGES,
    sidecarCommand,
    windowDist: windowTarget,
    webserver: { host: options.host, port: options.port },
    provisionedAt: new Date().toISOString(),
  }, undefined, 2)}\n`)
  console.log(`[provision-dsh] 清单 → ${plan.provisionManifestPath}`)
  console.log('[provision-dsh] 完成')
}

main().catch((error) => {
  console.error(`provision-dsh: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
