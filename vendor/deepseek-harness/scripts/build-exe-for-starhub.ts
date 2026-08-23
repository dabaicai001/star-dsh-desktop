/**
 * StarHub 专用单文件可执行构建脚本(P4b):把 dsh-jsonrpc-agent-pkg 闭包
 * (已含 @deepseek-ai/dsh-starhub-tools)用 @yao-pkg/pkg 的 --sea 模式打包成
 * 单文件 exe,作为 Tauri sidecar(externalBin)入包。
 *
 * 复用上游 build-exe-for-python-sdk.ts 的 --sea 路线(deploy --legacy →
 * 物化符号链接 → pkg --sea),差异:
 * - staging 落在 dist-exe/.starhub-staging(不污染 python 运行时目录);
 * - 产物输出到 StarHub 的 src-tauri/binaries/(Tauri externalBin 目录);
 * - 只构建 host 面(build:lib:host),不做 Python 侧同步。
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { chmod, copyFile, cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

/** vendor/deepseek-harness 仓库根。 */
const root = resolve(import.meta.dirname, '..')

/** 闭包清单(纯依赖 deploy root),其 dependencies 定义 exe 打包内容。 */
const DEPLOY_ROOT_PACKAGE = 'dsh-jsonrpc-agent-pkg'
/** 闭包内的封闭运行时入口。 */
const ENTRY_BIN = 'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js'
const OUTPUT_BASENAME = 'dsh-jsonrpc-agent-pkg'
/** SEA 模式要求 node ≥ 22,统一目标 node24。 */
const DEFAULT_NODE_RANGE = 'node24'
/** 固定版本保证可复现构建。 */
const PKG_SPEC = '@yao-pkg/pkg@6.21.0'
/** staging 目录(vendor 内,打包后即可丢弃)。 */
const STAGING_DIR = 'dist-exe/.starhub-staging'
/** StarHub src-tauri/binaries(相对 vendor 根向上两级)。 */
const STARHUB_BINARIES_DIR = resolve(root, '..', '..', 'src-tauri', 'binaries')
/** legacy deploy 可能把直接依赖 hoist 回 deploy source 的 node_modules。 */
const DEPLOY_SOURCE_NODE_MODULES = 'python/sdk-runtime/node_modules'
/** 部署产物中排除的文档文件。 */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml']

/**
 * 全树资产覆盖 Cordis 运行时裸包名动态 import(pkg 静态分析看不到)。
 * package.json 显式列出,因为裸名解析依赖它。
 */
const ASSET_GLOBS = [
  'package.json',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.node',
  'node_modules/**/*.wasm',
]

const PLATFORMS = ['linux', 'macos', 'win'] as const
const ARCHES = ['x64', 'arm64'] as const
type Platform = (typeof PLATFORMS)[number]
type Arch = (typeof ARCHES)[number]

function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value)
}

function isArch(value: string): value is Arch {
  return (ARCHES as readonly string[]).includes(value)
}

/** pkg 目标三元组(node 范围 + 平台 + 架构)。 */
class Target {
  private constructor(
    readonly nodeRange: string,
    readonly platform: Platform,
    readonly arch: Arch,
  ) {}

  get spec(): string {
    return `${this.nodeRange}-${this.platform}-${this.arch}`
  }

  static parse(spec: string): Target {
    const parts = spec.split('-')
    const [nodeRange, platform, arch] = parts
    if (parts.length !== 3 || nodeRange === undefined || platform === undefined || arch === undefined) {
      throw new Error(`build-exe-for-starhub: target ${JSON.stringify(spec)} 必须是 <nodeRange>-<platform>-<arch>,如 node24-win-x64。`)
    }
    if (!/^node\d+$/.test(nodeRange)) {
      throw new Error(`build-exe-for-starhub: target ${JSON.stringify(spec)}: node 范围须形如 node24,得到 ${JSON.stringify(nodeRange)}。`)
    }
    if (!isPlatform(platform)) {
      throw new Error(`build-exe-for-starhub: target ${JSON.stringify(spec)}: platform 必须是 ${PLATFORMS.join(', ')},得到 ${JSON.stringify(platform)}。`)
    }
    if (!isArch(arch)) {
      throw new Error(`build-exe-for-starhub: target ${JSON.stringify(spec)}: arch 必须是 ${ARCHES.join(', ')},得到 ${JSON.stringify(arch)}。`)
    }
    return new Target(nodeRange, platform, arch)
  }

  static host(): Target {
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : process.platform === 'win32' ? 'win' : undefined
    if (platform === undefined) {
      throw new Error(`build-exe-for-starhub: 不支持的宿主平台 ${process.platform};请用 --targets 显式指定。`)
    }
    const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
    if (arch === undefined) {
      throw new Error(`build-exe-for-starhub: 不支持的宿主架构 ${process.arch};请用 --targets 显式指定。`)
    }
    return new Target(DEFAULT_NODE_RANGE, platform, arch)
  }
}

class BuildCli {
  private constructor(
    readonly targets: readonly Target[],
    readonly skipBuild: boolean,
    readonly dryRun: boolean,
  ) {}

  static parse(argv: string[]): BuildCli {
    let values: ReturnType<typeof BuildCli.parseRaw>
    try {
      values = BuildCli.parseRaw(argv)
    } catch (error) {
      console.error(`build-exe-for-starhub: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(BuildCli.usage())
      process.exit(1)
    }
    if (values.help) {
      console.log(BuildCli.usage())
      process.exit(0)
    }
    const targets = values.targets === undefined
      ? [Target.host()]
      : values.targets.split(',').map(part => part.trim()).filter(part => part !== '').map(spec => Target.parse(spec))
    if (targets.length === 0) throw new Error('build-exe-for-starhub: --targets 为空。')
    const seen = new Set<string>()
    for (const target of targets) {
      const key = `${target.platform}-${target.arch}`
      if (seen.has(key)) {
        throw new Error(`build-exe-for-starhub: --targets 里平台-架构 ${key} 重复;产物名会冲突。`)
      }
      seen.add(key)
    }
    return new BuildCli(targets, values['skip-build'], values['dry-run'])
  }

  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'targets': { type: 'string' },
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  private static usage(): string {
    return [
      'Usage: pnpm exec tsx scripts/build-exe-for-starhub.ts [flags]',
      '',
      '  --targets=<t1,t2,...>  pkg 目标,如 node24-win-x64。默认:宿主平台(node24)。',
      '  --skip-build           跳过构建(lib/ 产物必须已存在)。',
      '  --dry-run              只打印命令与文件改动,不实际执行。',
      '  --help                 打印帮助。',
      '',
      `构建路线: ${PKG_SPEC} --sea;产物输出到 ${STARHUB_BINARIES_DIR}/。`,
    ].join('\n')
  }
}

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

class SingleExeBuild {
  readonly staging = resolve(root, STAGING_DIR)
  private readonly outDir = STARHUB_BINARIES_DIR

  constructor(private readonly cli: BuildCli) {}

  async verifyClosure(): Promise<void> {
    await this.run('runtime dependency closure', pnpmBin(), ['run', 'verify-runtime-closure'])
  }

  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('build-exe-for-starhub: 跳过构建 (--skip-build)')
      return
    }
    // 只构建 host 面(SEA exe 不需要 client/web 前端产物)。
    await this.run('build', pnpmBin(), ['run', 'build:lib:host'])
  }

  async deployStaging(): Promise<void> {
    if (this.staging === root || root.startsWith(this.staging + sep)) {
      throw new Error(`build-exe-for-starhub: 拒绝清理 staging 目录 ${this.staging}:它包含仓库根。`)
    }
    if (this.cli.dryRun) console.log(`build-exe-for-starhub: [dry-run] rm -rf ${this.staging}`)
    else await rm(this.staging, { recursive: true, force: true })
    await this.run('deploy', pnpmBin(), [
      '--filter',
      DEPLOY_ROOT_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      this.staging,
    ])
    await this.restoreLegacyHoists()
    await this.materializeStagedLinks()
    if (this.cli.dryRun) {
      for (const name of DEPLOY_ONLY_DOCS) console.log(`build-exe-for-starhub: [dry-run] rm -f ${join(this.staging, name)}`)
    } else {
      await Promise.all(DEPLOY_ONLY_DOCS.map(name => rm(join(this.staging, name), { force: true })))
    }
  }

  private async restoreLegacyHoists(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-for-starhub: [dry-run] 恢复 legacy deploy 遗漏的直接依赖')
      return
    }
    const manifestPath = join(this.staging, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const sourceNodeModules = resolve(root, DEPLOY_SOURCE_NODE_MODULES)
    const restored: string[] = []
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      const destination = join(this.staging, 'node_modules', dependency)
      if (existsSync(destination)) continue
      const source = join(sourceNodeModules, dependency)
      if (!existsSync(source)) {
        throw new Error(
          `build-exe-for-starhub: 部署依赖 ${dependency} 在 ${destination} 与 ${source} 均缺失。`,
        )
      }
      await mkdir(dirname(destination), { recursive: true })
      const nestedNodeModules = join(source, 'node_modules')
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      restored.push(dependency)
    }
    const stillMissing = Object.keys(manifest.dependencies ?? {})
      .filter(dependency => !existsSync(join(this.staging, 'node_modules', dependency)))
    if (stillMissing.length > 0) {
      throw new Error(`build-exe-for-starhub: staged 依赖仍缺失: ${stillMissing.join(', ')}。`)
    }
    if (restored.length > 0) {
      console.log(`build-exe-for-starhub: 已恢复 legacy deploy hoist: ${restored.join(', ')}`)
    }
  }

  private async materializeStagedLinks(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-for-starhub: [dry-run] 物化 staged 包链接')
      return
    }
    const nodeModules = join(this.staging, 'node_modules')
    let materialized = 0
    let removedBins = 0
    // Windows 下 pnpm 会产出大量真符号链接;一次性收集再批量物化,避免
    // 每物化一个就重新全树遍历(旧实现为 O(n^2),千级链接时耗时数十分钟)。
    while (true) {
      const links = await this.collectSymlinks(nodeModules)
      if (links.length === 0) break
      for (const destination of links) {
        const segments = destination.slice(nodeModules.length + 1).split(sep)
        const binIndex = segments.lastIndexOf('.bin')
        if (binIndex >= 0) {
          await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
          removedBins += 1
        }
      }
      for (const destination of links) {
        const segments = destination.slice(nodeModules.length + 1).split(sep)
        if (segments.lastIndexOf('.bin') >= 0) continue
        let source: string
        try {
          source = await realpath(destination)
        } catch {
          continue // 已在 .bin 移除或前序物化中消失
        }
        const nestedNodeModules = join(source, 'node_modules')
        const nestedDistExe = join(source, 'dist-exe')
        await rm(destination, { recursive: true, force: true })
        await cp(source, destination, {
          recursive: true,
          dereference: true,
          filter: path => (
            path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep)
            && path !== nestedDistExe && !path.startsWith(nestedDistExe + sep)
          ),
        })
        materialized += 1
      }
    }
    if (materialized > 0 || removedBins > 0) {
      console.log(`build-exe-for-starhub: 已物化 ${materialized} 个符号链接、移除 ${removedBins} 个 .bin shim`)
    }
  }

  private async collectSymlinks(directory: string): Promise<string[]> {
    const result: string[] = []
    const stack: string[] = [directory]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) break
      let entries: Dirent[]
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          result.push(join(current, entry.name))
        } else if (entry.isDirectory()) {
          stack.push(join(current, entry.name))
        }
      }
    }
    return result
  }

  async injectPkgConfig(): Promise<void> {
    const patch = { bin: ENTRY_BIN, pkg: { assets: ASSET_GLOBS } }
    const manifestPath = join(this.staging, 'package.json')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-starhub: [dry-run] patch ${manifestPath} 注入 ${JSON.stringify(patch)}`)
      return
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`build-exe-for-starhub: ${manifestPath} 缺失 — pnpm deploy 未产出 staged 包。`)
    }
    if (!existsSync(join(this.staging, ENTRY_BIN))) {
      throw new Error(`build-exe-for-starhub: ${join(this.staging, ENTRY_BIN)} 缺失 — 请先构建 lib/ 产物(勿用 --skip-build)。`)
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`)
    console.log(`build-exe-for-starhub: 已注入 pkg 配置到 ${manifestPath}`)
  }

  async pack(target: Target): Promise<string[]> {
    const product = join(this.outDir, `${OUTPUT_BASENAME}-${target.platform}-${target.arch}${target.platform === 'win' ? '.exe' : ''}`)
    await this.prepareNativePty(target)
    if (!this.cli.dryRun) await mkdir(this.outDir, { recursive: true })
    await this.run(`pkg ${target.spec}`, pnpmBin(), [
      'dlx',
      PKG_SPEC,
      this.staging,
      '--sea',
      '--targets',
      target.spec,
      '--output',
      product,
    ])
    if (!this.cli.dryRun && !existsSync(product)) {
      throw new Error(`build-exe-for-starhub: 产物 ${product} 在 pkg 运行后缺失;检查 ${this.outDir}。`)
    }
    if (target.platform !== 'macos') return [product]
    const spawnHelper = `${product}-spawn-helper`
    const source = join(this.staging, 'node_modules', 'node-pty', 'prebuilds', `darwin-${target.arch}`, 'spawn-helper')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-starhub: [dry-run] cp ${source} ${spawnHelper}`)
    } else {
      await copyFile(source, spawnHelper)
      await chmod(spawnHelper, 0o755)
    }
    return [product, spawnHelper]
  }

  private async prepareNativePty(target: Target): Promise<void> {
    const stagedBuild = join(this.staging, 'node_modules', 'node-pty', 'build')
    if (this.cli.dryRun) console.log(`build-exe-for-starhub: [dry-run] rm -rf ${stagedBuild}`)
    else await rm(stagedBuild, { recursive: true, force: true })
    if (target.platform !== 'linux') return
    const source = join(root, 'packages', 'subprocess', 'subprocess-local', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
    const destination = join(stagedBuild, 'Release', 'pty.node')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-starhub: [dry-run] cp ${source} ${destination}`)
      return
    }
    const host = Target.host()
    if (target.platform !== host.platform || target.arch !== host.arch) {
      throw new Error(
        'build-exe-for-starhub: Linux 运行时须在目标架构上构建;'
        + `目标 ${target.platform}-${target.arch} 与宿主 ${host.platform}-${host.arch} 不匹配。`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  printProducts(products: string[]): void {
    console.log(this.cli.dryRun ? 'build-exe-for-starhub: [dry-run] 将产出:' : 'build-exe-for-starhub: 产物:')
    for (const path of products) {
      if (this.cli.dryRun) {
        console.log(`  ${path}`)
        continue
      }
      const megabytes = statSync(path).size / (1024 * 1024)
      console.log(`  ${path}  (${megabytes.toFixed(1)} MB)`)
    }
  }

  private async run(label: string, command: string, args: string[]): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.cli.dryRun) {
      console.log(`build-exe-for-starhub: [dry-run] ${printable}`)
      return
    }
    console.log(`build-exe-for-starhub: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      // Windows 自 Node CVE-2024-27980 加固后无法 spawn .cmd,需 shell;shell 拼接
      // 不会自动给含空格参数加引号,这里手动处理路径类参数。
      const shellArgs = process.platform === 'win32'
        ? args.map(arg => (arg.includes(' ') ? `"${arg}"` : arg))
        : args
      const child = spawn(command, shellArgs, {
        cwd: root,
        stdio: 'inherit',
        // Windows 自 Node CVE-2024-27980 加固后无法 spawn .cmd,需 shell。
        shell: process.platform === 'win32',
      })
      child.once('error', (error) => {
        reject(new Error(`build-exe-for-starhub: ${label} 启动失败: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`build-exe-for-starhub: ${label} 失败 (${cause}): ${printable}`))
      })
    })
  }
}

async function main(): Promise<void> {
  const cli = BuildCli.parse(process.argv.slice(2))
  const pipeline = new SingleExeBuild(cli)
  console.log(`build-exe-for-starhub: 目标: ${cli.targets.map(target => target.spec).join(', ')}`)
  console.log(`build-exe-for-starhub: staging: ${pipeline.staging}`)
  await pipeline.verifyClosure()
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.injectPkgConfig()
  const products: string[] = []
  for (const target of cli.targets) products.push(...await pipeline.pack(target))
  pipeline.printProducts(products)
}

await main()
