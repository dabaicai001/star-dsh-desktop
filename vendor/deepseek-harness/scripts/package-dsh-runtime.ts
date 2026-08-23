/**
 * StarHub dsh-runtime 入包脚本(P4b):便携 Node + vendor prod 闭包整体入包。
 *
 * 产出 `src-tauri/binaries/dsh-runtime/`(由 tauri.conf.json 的 bundle.resources
 * 引用,Tauri 打包后落在 `resource_dir()/dsh-runtime`):
 *   node(.exe)                    # 官方 node24 portable(按目标平台)
 *   node_modules/                 # pnpm deploy --prod 物化后的依赖闭包
 *                                  # (含补入的 dsh web 运行时包,见
 *                                  # installWebRuntimePackages)
 *   config/starhub-agent.yml      # AI 内核主组合(纯对话 + starhub-tools)
 *   apps/cli/lib/bin.js           # dsh web GUI 入口
 *   examples/starhub-web/         # dsh web GUI profile 模板
 *
 * 运行时 HarnessPaths 从 resource_dir()/dsh-runtime 解析 node / config / 入口;
 * dev 布局(仓库内 vendor/deepseek-harness)保持不变。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

/** vendor/deepseek-harness 仓库根。 */
const root = resolve(import.meta.dirname, '..')

/** 闭包清单(纯依赖 deploy root),其 dependencies 定义入包内容。 */
const DEPLOY_ROOT_PACKAGE = 'dsh-jsonrpc-agent-pkg'
/** staging 目录(vendor 内,打包后即可丢弃)。 */
const STAGING_DIR = 'dist-exe/.starhub-staging'
/** StarHub src-tauri/binaries(相对 vendor 根向上两级)。 */
const STARHUB_BINARIES_DIR = resolve(root, '..', '..', 'src-tauri', 'binaries')
/** 最终资源目录名。 */
const OUTPUT_DIR = 'dsh-runtime'
/** legacy deploy 可能把直接依赖 hoist 回 deploy source 的 node_modules。 */
const DEPLOY_SOURCE_NODE_MODULES = 'python/sdk-runtime/node_modules'
/** 部署产物中排除的文档文件。 */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml']

/** 便携 Node 版本(官方 LTS v24 线,固定版本保证可复现)。 */
const NODE_VERSION = 'v24.19.0'
const NODE_DIST_BASE = 'https://nodejs.org/dist'

/** 各平台/架构对应的 node 官方发行包与解压后二进制相对路径。 */
function nodeDistSpec(): { archive: string; binRel: string; binName: string } {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'win32' && arch === 'x64') {
    return {
      archive: `node-${NODE_VERSION}-win-x64.zip`,
      binRel: `node-${NODE_VERSION}-win-x64/node.exe`,
      binName: 'node.exe',
    }
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      archive: `node-${NODE_VERSION}-linux-x64.tar.xz`,
      binRel: `node-${NODE_VERSION}-linux-x64/bin/node`,
      binName: 'node',
    }
  }
  if (platform === 'linux' && arch === 'arm64') {
    return {
      archive: `node-${NODE_VERSION}-linux-arm64.tar.xz`,
      binRel: `node-${NODE_VERSION}-linux-arm64/bin/node`,
      binName: 'node',
    }
  }
  if (platform === 'darwin' && arch === 'x64') {
    return {
      archive: `node-${NODE_VERSION}-darwin-x64.tar.gz`,
      binRel: `node-${NODE_VERSION}-darwin-x64/bin/node`,
      binName: 'node',
    }
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      archive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
      binRel: `node-${NODE_VERSION}-darwin-arm64/bin/node`,
      binName: 'node',
    }
  }
  throw new Error(`package-dsh-runtime: 不支持的平台/架构: ${platform}/${arch}`)
}

/** AI 内核主组合:dev 下 examples/starhub-agent/cordis.yml,prod 下平移到 config/。 */
const CONFIG_SOURCE_REL = 'examples/starhub-agent/cordis.yml'
const CONFIG_DEST_REL = 'config/starhub-agent.yml'

/** web GUI 需要的静态 vendor 产物(相对 vendor 根)。
 * bin.js 在运行时读取 ../package.json 作为版本与 install anchor,
 * 动态 import lib 下的 chunk(profile-boot/plugin/dump-config),并
 * 以 ../config/agent-presets 作为系统内置 agent 预设根;整体复制。 */
const WEB_STATIC_RELS = [
  'apps/cli/package.json',
  'apps/cli/lib',
  'apps/cli/config',
  'examples/starhub-web/package.json',
  'examples/starhub-web/cordis.patch.yml',
]

/** web GUI 需要补 junction 的本地包(packages/starhub/ 下目录名),
 * 与 Rust web.rs 的 LOCAL_PACKAGES 对齐;入包后保持 dev 布局可复用 junction 逻辑。
 * tool-context 自 v0.71 起被 examples/starhub-web/cordis.patch.yml 引用,
 * 2026-08-18 起壳内会话可调 starhub 工具,starhub-tools / approval-bridge /
 * session-registry / domain-events / live-context 一并入列,
 * 2026-08-21 起 memory-context 入列(pre-step 长期记忆注入),
 * 2026-08-22 起 commit-message 入列(分支胶囊「AI 生成提交信息」端点),
 * 2026-08-22 起 memory-sink 入列(agent/turn-stopping 自动沉淀,v0.92.2 事故:
 * 模板已引用而此清单漏列,导致安装包启动 ERR_MODULE_NOT_FOUND),
 * 不入包则 profile 启动时按 fail-loud 拒绝缺失插件。 */
const WEB_LOCAL_PACKAGE_DIRS = [
  'client-nav',
  'host-static',
  'tool-context',
  'tools',
  'approval-bridge',
  'session-registry',
  'domain-events',
  'live-context',
  'memory-context',
  'memory-sink',
  'commit-message',
]

class BuildCli {
  private constructor(
    readonly skipBuild: boolean,
    readonly nodeZip?: string,
  ) {}

  static parse(argv: string[]): BuildCli {
    let values: ReturnType<typeof BuildCli.parseRaw>
    try {
      values = BuildCli.parseRaw(argv)
    } catch (error) {
      console.error(`package-dsh-runtime: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(BuildCli.usage())
      process.exit(1)
    }
    if (values.help) {
      console.log(BuildCli.usage())
      process.exit(0)
    }
    return new BuildCli(values['skip-build'], values['node-zip'])
  }

  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'skip-build': { type: 'boolean', default: false },
        'node-zip': { type: 'string' },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  private static usage(): string {
    return [
      'Usage: pnpm exec tsx scripts/package-dsh-runtime.ts [flags]',
      '',
      '  --skip-build         跳过 build:lib(lib/ 产物必须已存在)。',
      '  --node-zip <path>    使用本地 node 官方 zip(缺省从 nodejs.org 下载)。',
      '  --help               打印帮助。',
      '',
      `产出: ${resolve(STARHUB_BINARIES_DIR, OUTPUT_DIR)}/`,
    ].join('\n')
  }
}

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

class DshRuntimePackage {
  readonly staging = resolve(root, STAGING_DIR)
  private readonly outDir = resolve(STARHUB_BINARIES_DIR, OUTPUT_DIR)

  constructor(private readonly cli: BuildCli) {}

  async verifyClosure(): Promise<void> {
    await this.run('runtime dependency closure', pnpmBin(), ['run', 'verify-runtime-closure'])
  }

  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('package-dsh-runtime: 跳过构建 (--skip-build)')
      return
    }
    // dsh web GUI 运行时需要 client-nav 的 node 半(lib/index.js)与浏览器
    // bundle(lib/client.js),两者都是 client 面产物;仅 build:lib:host 会在全新
    // checkout 上缺 client-nav/lib。这里构建完整 lib(host + client)。
    // 还必须跑 build:web:dsh-web-app 经 require.resolve(
    // '@deepseek-ai/dsh-web-frontend/dist/index.html') 定位浏览器入口,而
    // dsh-web-frontend 的 files 只放行 dist;缺 vite 产物时 deploy 闭包里只剩
    // package.json,安装包内 dsh web 必炸(v0.78.0 事故)。
    await this.run('build', pnpmBin(), ['run', 'build'])
  }

  async deployStaging(): Promise<void> {
    if (this.staging === root || root.startsWith(this.staging + sep)) {
      throw new Error(`package-dsh-runtime: 拒绝清理 staging 目录 ${this.staging}:它包含仓库根。`)
    }
    await rm(this.staging, { recursive: true, force: true })
    // 与上游 build-exe-for-python-sdk.ts 一致:hoisted 提供扁平单实例布局,
    // 物化符号链接后便携 node 才能沿顶层 node_modules 解析传递依赖(如 js-yaml);
    // auto-install-peers=false 防未声明 peer 扩大闭包,link-workspace-packages=true
    // 选择直接工作区依赖(实测依据见 .agents/notes 的 single-file-executable 记录)。
    await this.run('deploy', pnpmBin(), [
      '--filter',
      DEPLOY_ROOT_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      // legacy --prod 会就地 pnpm install --production,把 devDep(含 lefthook)
      // 移除后仍跑根 postinstall(静态 import 'lefthook/package.json'),本地必炸;
      // 闭包 native 产物已由首次完整 install 缓存于 store,这里跳过脚本无副作用。
      '--config.ignore-scripts=true',
      this.staging,
    ])
    await this.restoreLegacyHoists()
    await this.materializeStagedLinks()
    await Promise.all(DEPLOY_ONLY_DOCS.map(name => rm(join(this.staging, name), { force: true })))
  }

  /// `pnpm deploy --legacy --prod` 会把根 node_modules 剪成 production(移除
  /// devDeps 含 tsx),破坏后续 `pnpm exec tsx` 与本地开发环境;这里恢复完整安装。
  async restoreDevDeps(): Promise<void> {
    await this.run('restore devDeps', pnpmBin(), ['install'])
  }

  private async restoreLegacyHoists(): Promise<void> {
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
          `package-dsh-runtime: 部署依赖 ${dependency} 在 ${destination} 与 ${source} 均缺失。`,
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
      throw new Error(`package-dsh-runtime: staged 依赖仍缺失: ${stillMissing.join(', ')}。`)
    }
    if (restored.length > 0) {
      console.log(`package-dsh-runtime: 已恢复 legacy deploy hoist: ${restored.join(', ')}`)
    }
  }

  private async materializeStagedLinks(): Promise<void> {
    const nodeModules = join(this.staging, 'node_modules')
    let materialized = 0
    let removedBins = 0
    // Windows 下 pnpm 产出大量真符号链接;一次性收集再批量物化,避免
    // 每物化一个就重新全树遍历(旧实现 O(n^2),千级链接时耗时数十分钟)。
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
          // 悬空符号链接/junction(CI 全新 pnpm store 里平台可选文件缺失时出现):
          // 目标已不存在,留在产物树会让 NSIS 遍历时报 "failed opening file" 打包失败;
          // 运行时也用不到它(目标都没有),直接删除。
          await rm(destination, { recursive: true, force: true })
          removedBins += 1
          continue
        }
        if (!existsSync(source)) {
          await rm(destination, { recursive: true, force: true })
          removedBins += 1
          continue
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
      console.log(`package-dsh-runtime: 已物化 ${materialized} 个符号链接、移除 ${removedBins} 个 .bin shim/悬空链接`)
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

  /** 清扫整棵产物树里的悬空符号链接/junction(realpath 失败或目标不存在)。
   * 这类条目会让 NSIS `File /r` 在遍历时报 "failed opening file" 中断打包;
   * 目标都不存在,运行时也用不到,直接删除是唯一正确结局。 */
  private async sweepDanglingLinks(directory: string): Promise<void> {
    const stack: string[] = [directory]
    const dangling: string[] = []
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
        const path = join(current, entry.name)
        if (entry.isSymbolicLink()) {
          try {
            const target = await realpath(path)
            if (!existsSync(target)) dangling.push(path)
          } catch {
            dangling.push(path)
          }
        } else if (entry.isDirectory()) {
          stack.push(path)
        }
      }
    }
    for (const path of dangling) {
      await rm(path, { recursive: true, force: true })
    }
    if (dangling.length > 0) {
      console.log(`package-dsh-runtime: 清扫悬空链接 ${dangling.length} 个(NSIS 打包前置防线)`)
    }
  }

  /** 删除 node_modules 全树里的类型/sourcemap 产物:`*.d.ts` / `*.d.ts.map` /
   * `*.js.map`。运行时只 import 编译后的 .js,这些文件纯体积与路径负担。 */
  private async stripTypeArtifacts(directory: string): Promise<void> {
    const stack: string[] = [directory]
    const stripped: string[] = []
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
        const path = join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(path)
          continue
        }
        if (!entry.isFile()) continue
        const name = entry.name
        if (name.endsWith('.d.ts') || name.endsWith('.d.ts.map') || name.endsWith('.js.map')) {
          stripped.push(path)
        }
      }
    }
    for (const path of stripped) {
      await rm(path, { force: true })
    }
    if (stripped.length > 0) {
      console.log(`package-dsh-runtime: 裁剪类型/sourcemap 产物 ${stripped.length} 个(体积 + 路径)`)
    }
  }

  async downloadNodeExe(): Promise<string> {
    const { archive: archiveName, binRel } = nodeDistSpec()
    const cacheDir = join(root, 'dist-exe', '.node-cache')
    const extracted = join(cacheDir, binRel)
    if (existsSync(extracted)) return extracted
    await mkdir(cacheDir, { recursive: true })
    const archivePath = this.cli.nodeZip ?? join(cacheDir, archiveName)
    if (this.cli.nodeZip !== undefined && !existsSync(archivePath)) {
      throw new Error(`package-dsh-runtime: 指定的 node 归档不存在: ${archivePath}`)
    }
    if (!existsSync(archivePath)) {
      const url = `${NODE_DIST_BASE}/${NODE_VERSION}/${archiveName}`
      console.log(`package-dsh-runtime: 下载 ${url}`)
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`package-dsh-runtime: 下载 node 失败: HTTP ${response.status}`)
      }
      await writeFile(archivePath, Buffer.from(await response.arrayBuffer()))
    } else {
      console.log(`package-dsh-runtime: 使用本地 node 归档: ${archivePath}`)
    }
    await this.expandArchive(archivePath, cacheDir)
    if (!existsSync(extracted)) {
      throw new Error(`package-dsh-runtime: 解压后未找到 ${extracted}`)
    }
    return extracted
  }

  private expandArchive(archivePath: string, destDir: string): Promise<void> {
    if (process.platform === 'win32') {
      const script = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
      return new Promise<void>((resolvePromise, reject) => {
        const child = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' })
        child.once('error', reject)
        child.once('exit', (code) => {
          if (code === 0) resolvePromise()
          else reject(new Error(`package-dsh-runtime: Expand-Archive 失败 (exit ${code})`))
        })
      })
    }
    const args = archivePath.endsWith('.tar.xz')
      ? ['-xJf', archivePath, '-C', destDir]
      : ['-xzf', archivePath, '-C', destDir]
    return new Promise<void>((resolvePromise, reject) => {
      const child = spawn('tar', args, { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolvePromise()
        else reject(new Error(`package-dsh-runtime: tar 解压失败 (exit ${code})`))
      })
    })
  }

  async assembleRuntime(nodeExe: string): Promise<string> {
    if (this.outDir === root || root.startsWith(this.outDir + sep)) {
      throw new Error(`package-dsh-runtime: 拒绝清理输出目录 ${this.outDir}:它包含仓库根。`)
    }
    await rm(this.outDir, { recursive: true, force: true })
    await mkdir(this.outDir, { recursive: true })

    const { binName } = nodeDistSpec()
    console.log(`package-dsh-runtime: 组装 dsh-runtime(${binName} + node_modules + config + web 静态产物)`)
    await copyFile(nodeExe, join(this.outDir, binName))
    if (process.platform !== 'win32') {
      await chmod(join(this.outDir, binName), 0o755)
    }

    // 物化后的 staging/node_modules;再 dereference 一次兜底,确保最终无符号链接
    await cp(join(this.staging, 'node_modules'), join(this.outDir, 'node_modules'), {
      recursive: true,
      dereference: true,
    })
    // 最后兜底:产物树里不应存在任何无法解析的符号链接/junction
    // (dereference cp 对悬空链接在部分 Node 版本上会原样保留/报错,
    // 这里是打包前最后的防线,确保 NSIS 不会在遍历时失败)。
    await this.sweepDanglingLinks(join(this.outDir, 'node_modules'))

    await mkdir(join(this.outDir, dirname(CONFIG_DEST_REL)), { recursive: true })
    await copyFile(join(root, CONFIG_SOURCE_REL), join(this.outDir, CONFIG_DEST_REL))

    for (const rel of WEB_STATIC_RELS) {
      const destination = join(this.outDir, rel)
      await mkdir(dirname(destination), { recursive: true })
      await cp(join(root, rel), destination, { recursive: true })
    }
    for (const dir of WEB_LOCAL_PACKAGE_DIRS) {
      const destination = join(this.outDir, 'packages', 'starhub', dir)
      await mkdir(dirname(destination), { recursive: true })
      await cp(join(root, 'packages', 'starhub', dir), destination, { recursive: true })
    }
    await this.installWebRuntimePackages()
    this.verifyProfilePatchClosure()
    this.verifyWebFrontendDist()
    // 产物裁剪:删除 node_modules 内全部 .d.ts / .d.ts.map / .js.map——运行时
    // 只 import lib/index.js,不读类型与 sourcemap。一举两得:①安装包显著变小;
    // ②消掉 mistralai/otel 等深层 long-path 类型文件,缓解 Windows NSIS 260 字符
    // 路径上限(still 有 11 个 runtime .js 超限,根治见 release.yml 的 subst 短路径)。
    await this.stripTypeArtifacts(join(this.outDir, 'node_modules'))
    return this.outDir
  }

  /** fail-loud 校验:starhub-web profile 引用的每个插件包都已随闭包入包。
   * examples/starhub-web/cordis.patch.yml 的 insert 行直接决定 web 组合的
   * 插件树;其中任一 `@deepseek-ai/*` 包缺失于产物顶层 node_modules,安装包
   * 启动即 ERR_MODULE_NOT_FOUND、插件树加载失败、dsh web 进程崩溃(v0.92.2
   * 的 dsh-starhub-memory-sink 事故:模板已引用而 WEB_LOCAL_PACKAGE_DIRS 漏列)。
   * 在打包期拦截,把「模板引用与入包清单漂移」变成构建失败而非运行时崩溃。 */
  private verifyProfilePatchClosure(): void {
    const patchPath = join(root, 'examples', 'starhub-web', 'cordis.patch.yml')
    const patch = readFileSync(patchPath, 'utf8')
    const referenced = [...patch.matchAll(/name:\s*['"](@deepseek-ai\/[^'"]+)['"]/g)]
      .map(match => match[1])
      .filter((name): name is string => name !== undefined)
      .filter((name, index, all) => all.indexOf(name) === index)
    const missing = referenced.filter(name => !existsSync(join(this.outDir, 'node_modules', ...name.split('/'))))
    if (missing.length > 0) {
      throw new Error(
        `package-dsh-runtime: starhub-web profile 引用的插件包未随闭包入包: ${missing.join(', ')}。`
        + '请加入 WEB_LOCAL_PACKAGE_DIRS(本地包)或 dsh-jsonrpc-agent-pkg 依赖(闭包包)后重新打包。',
      )
    }
  }

  /** fail-loud 校验:dsh web 浏览器入口必须已随闭包入包。
   * dsh-web-app 运行时 require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'),
   * 缺失则 dsh web 启动即抛 "frontend dist not built",安装包整体不可用;
   * 在打包期拦截,避免再发出 v0.78.0 那样的坏包。 */
  private verifyWebFrontendDist(): void {
    const distIndex = join(
      this.outDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html',
    )
    if (!existsSync(distIndex)) {
      throw new Error(
        `package-dsh-runtime: dsh-web-frontend/dist/index.html 未入包(缺 build:web 产物或 deploy 未带出 dist): ${distIndex}`,
      )
    }
  }

  /** dsh web GUI 需要、但 deploy 根(dsh-jsonrpc-agent-pkg)依赖闭包里没有的
   * 包,补入产物顶层 node_modules。dev 布局靠 pnpm 隐藏 hoist
   * `.pnpm/node_modules` 与 vendor 全量安装兜住,hoisted prod 闭包没有这两层:
   * - 两个 StarHub 本地包 → `@deepseek-ai/dsh-starhub-*`:loader 条目从
   *   cordis-plugin-loader 自身 realpath 向上做裸导入解析,hoisted 闭包里只有
   *   顶层 node_modules 在解析链上,缺包即 ERR_MODULE_NOT_FOUND。node 侧零外部
   *   依赖(client-nav 是空插件,host-static 只用 node 内置),补
   *   package.json + lib 即可。
   * - node-addon-require-builtin(+其唯一依赖 node-addon-native-custom-loader,
   *   均为纯 JS):profile-boot 在无 --expose-internals 时挂载 watch-only HMR,
   *   经它取 Node 内部 loader;缺失则 HMR 构造抛错、dsh web 启动后崩溃。 */
  private async installWebRuntimePackages(): Promise<void> {
    for (const dir of WEB_LOCAL_PACKAGE_DIRS) {
      const source = join(root, 'packages', 'starhub', dir)
      const destination = join(this.outDir, 'node_modules', '@deepseek-ai', `dsh-starhub-${dir}`)
      await mkdir(destination, { recursive: true })
      await copyFile(join(source, 'package.json'), join(destination, 'package.json'))
      await cp(join(source, 'lib'), join(destination, 'lib'), { recursive: true })
    }
    // require-builtin 经 apps/cli 的安装树解析(pnpm junction);它的传递依赖
    // (node-addon-native-custom-loader)与平台预构建原生包
    // (node-addon-require-builtin-<platform>-<arch>-<libc>,含 .node 产物)都在
    // 同一 .pnpm 条目下与之同级,一并物化进顶层闭包。
    const requireBuiltinSource = await realpath(
      join(root, 'apps', 'cli', 'node_modules', 'node-addon-require-builtin'),
    )
    const pnpmEntryDir = dirname(requireBuiltinSource)
    await cp(requireBuiltinSource, join(this.outDir, 'node_modules', 'node-addon-require-builtin'), {
      recursive: true,
      dereference: true,
    })
    for (const entry of await readdir(pnpmEntryDir, { withFileTypes: true })) {
      const name = entry.name
      if (name === 'node-addon-require-builtin') continue
      if (name === 'node-addon-native-custom-loader'
        || name.startsWith('node-addon-require-builtin-')) {
        await cp(join(pnpmEntryDir, name), join(this.outDir, 'node_modules', name), {
          recursive: true,
          dereference: true,
        })
      }
    }
  }

  printResult(outDir: string): void {
    let bytes = 0
    const stack = [outDir]
    while (stack.length > 0) {
      const dir = stack.pop()
      if (dir === undefined) break
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) stack.push(path)
        else if (entry.isFile()) bytes += statSync(path).size
      }
    }
    const megabytes = bytes / (1024 * 1024)
    console.log(`package-dsh-runtime: 产物: ${outDir}  (${megabytes.toFixed(1)} MB)`)
  }

  private async run(label: string, command: string, args: string[]): Promise<void> {
    const printable = formatCommand(command, args)
    console.log(`package-dsh-runtime: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      const shellArgs = process.platform === 'win32'
        ? args.map(arg => (arg.includes(' ') ? `"${arg}"` : arg))
        : args
      const child = spawn(command, shellArgs, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
      child.once('error', (error) => {
        reject(new Error(`package-dsh-runtime: ${label} 启动失败: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`package-dsh-runtime: ${label} 失败 (${cause}): ${printable}`))
      })
    })
  }
}

async function main(): Promise<void> {
  const cli = BuildCli.parse(process.argv.slice(2))
  const pipeline = new DshRuntimePackage(cli)
  console.log(`package-dsh-runtime: staging: ${pipeline.staging}`)
  await pipeline.verifyClosure()
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.restoreDevDeps()
  const nodeExe = await pipeline.downloadNodeExe()
  const outDir = await pipeline.assembleRuntime(nodeExe)
  pipeline.printResult(outDir)
}

await main()
