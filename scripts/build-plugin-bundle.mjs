#!/usr/bin/env node
/**
 * StarHub 纯插件化(DSH bundle 形态)组装脚本。
 *
 * 目标产物是一个**自包含的 DSH 组合包**:在 dsh 插件页「添加插件」里粘贴它的
 * 绝对路径即可安装(本地目录安装 = pnpm link,不装依赖、不联网)。因此本脚本
 * 只做一件事:把九个 StarHub 内置插件的运行时段 + 工作台 dist + 两个 sidecar
 * 二进制拼进一个包目录,并生成该包自己的 `package.json` 与 `cordis.patch.yml`。
 *
 * 三条形态约束(见 docs/纯插件化-适配清单.md):
 * 1. **零运行时依赖**:行模块只 import `@deepseek-ai/dsh-*` / `@deepseek-ai/schemastery`,
 *    这些由 dsh 安装树的运行时解析层供给(profile-resolution/installRuntimeInterception),
 *    所以包里不需要 node_modules;
 * 2. **零 peer 声明**:dsh 的兼容门只校验 `@deepseek-ai/dsh*` 的 peer;`workspace:^`
 *    在非 workspace 安装下既不可解析又会被判不兼容,本产物一个都不声明;
 * 3. **资产包内自解析**:sidecar 落在 bridge 模块同级的 `sidecar/`(Rust 侧按 exe
 *    同级兄弟名找 Go 侧),dist 落在 host-static 模块同级的 `dist/`——patch 里
 *    不出现任何机器相关绝对路径;
 * 4. **客户端注册 id = 安装包名**:`client.js` 由 tsdown 在构建期把**源包名**
 *    (`@deepseek-ai/dsh-starhub-client-nav`)烙进 `__ModuleLoader__.load({ id })`
 *    与样式标签,而宿主 boot 图按**安装包名**(本 bundle 名)建行,加载器只认
 *    同一个 id——不一致就 "loaded without registering",插件启用被回滚。组装时
 *    把产物里的源包名整体改写成 bundle 名(源码不动,workspace 内开发仍用它)。
 *
 * 用法:
 *   node scripts/build-plugin-bundle.mjs [--out <dir>] [--name <pkg>] [--version <x.y.z>]
 *     [--sidecar-rust <path>] [--sidecar-go <path>] [--window-dist <dir>] [--dry-run]
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorRoot = join(repoRoot, 'vendor', 'deepseek-harness')
const require = createRequire(import.meta.url)

/**
 * 组装进 bundle 的九个 StarHub 内置插件。
 *
 * `row` 是 patch 行的 id(与 `examples/starhub-desktop/cordis.patch.yml` 一致,
 * 用户覆盖与插件页开关都按 id 认,不许改名);`license` 承载每行的展示文案。
 */
const PLUGINS = [
  {
    short: 'client-nav', row: 'client-nav', idPrefix: 'starhub',
    entry: 'lib/index.js',
    title: { zh: 'StarHub 工作台导航', en: 'StarHub workbench navigation' },
    description: {
      zh: '把 StarHub 工具/工作台/直播入口注册进 DSH 侧栏与主面板。',
      en: 'Registers the StarHub tools, workbench, and live entries into the DSH sidebar and main panel.',
    },
  },
  {
    short: 'host-static', row: 'starhub-host-static',
    entry: 'lib/types/index.js', title: { zh: 'StarHub 工作台静态资源', en: 'StarHub workbench assets' },
    description: {
      zh: '在 /starhub-react 托管 React 工作台(数据库 / SSH / Docker 面板)。',
      en: 'Serves the React workbench (database, SSH, Docker panels) at /starhub-react.',
    },
  },
  {
    short: 'tool-context', row: 'starhub-tool-context',
    entry: 'lib/types/index.js', title: { zh: 'StarHub 工具上下文', en: 'StarHub tool context' },
    description: {
      zh: '把当前选中的 StarHub 工具与资产注入 agent 请求上下文。',
      en: 'Injects the selected StarHub tool and asset into agent request context.',
    },
  },
  {
    short: 'bridge', row: 'starhub-bridge',
    entry: 'lib/types/index.js', title: { zh: 'StarHub 桥接', en: 'StarHub bridge' },
    description: {
      zh: 'spawn Rust/Go sidecar,提供 StarHub API、事件流与直播帧通道。',
      en: 'Spawns the Rust and Go sidecars and provides the StarHub API, event stream, and live frame channel.',
    },
    config: { healthTimeoutMs: 15000 },
  },
  {
    short: 'tools', row: 'starhub-tools',
    entry: 'lib/types/index.js', title: { zh: 'StarHub 工具面', en: 'StarHub tools' },
    description: {
      zh: '把 sidecar 的方法面注册为模型工具(starhub_*)。',
      en: 'Registers the sidecar method surface as model tools (starhub_*).',
    },
  },
  {
    short: 'approval-bridge', row: 'starhub-approval-bridge',
    entry: 'lib/types/index.js', title: { zh: 'StarHub 审批桥接', en: 'StarHub approval bridge' },
    description: {
      zh: '把审批请求按 StarHub 风险门路由(桌面壳自带审批 UI 时只做判定)。',
      en: 'Routes approval requests through the StarHub risk gate.',
    },
    config: { answerer: false, ownsPermissionSettings: false },
  },
  {
    short: 'session-registry', row: 'starhub-session-registry',
    entry: 'lib/types/index.js', title: { zh: 'StarHub 会话注册表', en: 'StarHub session registry' },
    description: {
      zh: '消费 sidecar 推送的会话注册表并暴露给宿主。',
      en: 'Consumes the session registry pushed by the sidecar.',
    },
  },
  {
    short: 'domain-events', row: 'starhub-domain-events',
    entry: 'lib/types/index.js', title: { zh: 'StarHub 域事件', en: 'StarHub domain events' },
    description: {
      zh: '消费 sidecar 推送的领域事件(资产、连接、任务状态)。',
      en: 'Consumes domain events pushed by the sidecar.',
    },
  },
  {
    short: 'live-context', row: 'starhub-live-context',
    entry: 'lib/types/index.js', title: { zh: 'StarHub 直播上下文', en: 'StarHub live context' },
    description: {
      zh: '把直播/接管快照注入 agent 上下文。',
      en: 'Injects live and takeover snapshots into agent context.',
    },
  },
]

/** 客户端半边所在的行(唯一一个 `dsh.client` 声明者)。 */
const CLIENT_PLUGIN = 'client-nav'

/** client-nav 声明的包级依赖边(信息性,原样搬运)。 */
const CLIENT_INJECT = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-workspace',
]

/** 产物默认名与输出目录。 */
const DEFAULT_NAME = '@starhub/dsh-plugin'
const DEFAULT_OUT = join(repoRoot, 'dist-plugin')

/** 两个 sidecar 在包内的落地名(Rust 侧按这个名字找 Go 兄弟进程)。 */
const SIDECAR_NAMES = {
  rust: process.platform === 'win32' ? 'starhub-sidecar-rust.exe' : 'starhub-sidecar-rust',
  go: process.platform === 'win32' ? 'starhub-sidecar.exe' : 'starhub-sidecar',
}

/** StarHub 图标(原创:圆角方形 + 四角星,64×64 视口,无外部引用)。 */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="StarHub">
  <defs>
    <linearGradient id="starhub-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2f6bff"/>
      <stop offset="1" stop-color="#12b5a5"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#starhub-bg)"/>
  <path d="M32 13l4.9 12.6L49 30.5l-12.1 4.9L32 48l-4.9-12.6L15 30.5l12.1-4.9z" fill="#ffffff"/>
  <circle cx="32" cy="30.5" r="3.4" fill="#0d2340"/>
</svg>
`

function parseArgs(argv) {
  const values = {
    out: DEFAULT_OUT,
    name: DEFAULT_NAME,
    version: null,
    sidecarRust: join(repoRoot, 'sidecar-rust', 'target', 'release', SIDECAR_NAMES.rust),
    sidecarGo: join(repoRoot, 'sidecar', 'bin', SIDECAR_NAMES.go),
    windowDist: join(repoRoot, 'dist-starhub-react'),
    dryRun: false,
    pack: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`)
      return value
    }
    switch (arg) {
      case '--out': values.out = resolve(next()); break
      case '--name': values.name = next(); break
      case '--version': values.version = next(); break
      case '--sidecar-rust': values.sidecarRust = resolve(next()); break
      case '--sidecar-go': values.sidecarGo = resolve(next()); break
      case '--window-dist': values.windowDist = resolve(next()); break
      case '--dry-run': values.dryRun = true; break
      case '--pack': values.pack = true; break
      case '--help': console.log(usage()); process.exit(0)
      default: throw new Error(`未知参数 ${arg}`)
    }
  }
  return values
}

function usage() {
  return [
    'Usage: node scripts/build-plugin-bundle.mjs [flags]',
    '',
    '  --out <dir>           产物目录,缺省 dist-plugin。',
    '  --name <pkg>          bundle 包名,缺省 @starhub/dsh-plugin。',
    '  --version <x.y.z>     包版本,缺省取仓库 package.json 版本。',
    '  --sidecar-rust <path> Rust sidecar 二进制,缺省 target/release(缺失时回退 debug)。',
    '  --sidecar-go <path>   Go sidecar 二进制,缺省 sidecar/bin/starhub-sidecar[.exe]。',
    '  --window-dist <dir>   React 工作台 dist,缺省 dist-starhub-react。',
    '  --pack                额外用 npm pack 打出 .tgz(pnpm 安装会把包解进 profile,',
    '                        而「本地目录路径」在 dsh 里是 link,行模块的 @deepseek-ai/*',
    '                        裸 import 会解析失败——所以正式安装走包名或这个 tarball)。',
    '  --dry-run             只做前置校验与计划打印,不落盘。',
    '',
  ].join('\n')
}

/** 取 YAML 解析器(与 provisioning 同款:只用 vendor 闭包自带的 js-yaml)。 */
function loadYamlParser() {
  for (const candidate of [
    join(repoRoot, 'node_modules', 'js-yaml'),
    join(vendorRoot, 'node_modules', 'js-yaml'),
  ]) {
    try {
      return require(candidate)
    } catch {
      // 试下一个候选
    }
  }
  return null
}

/** Rust sidecar 的缺省候选:release 缺失时用 debug 构建(开发机常见)。 */
function resolveRustSidecar(configured) {
  if (existsSync(configured)) return configured
  const debug = join(repoRoot, 'sidecar-rust', 'target', 'debug', SIDECAR_NAMES.rust)
  return existsSync(debug) ? debug : configured
}

/** 生成 patch 全文(纯 insert,不覆盖任何上游行)。 */
function renderPatch(packageName) {
  const lines = [
    '# StarHub 组合包(DSH bundle)的插件层。',
    '#',
    '# 只 insert StarHub 自己的行;上游行(webserver / permission / session-query-sqlite)',
    '# 一律不动——「装一个业务插件顺手改全局审批与检索语义」不该是默认行为。',
    '# 行的 id 是公共标识:用户覆盖与插件页开关都按 id 认,改名等于破坏既有覆盖。',
    '- insert:',
  ]
  for (const plugin of PLUGINS) {
    const name = plugin.short === CLIENT_PLUGIN ? packageName : `${packageName}/${plugin.short}`
    lines.push(`    - id: ${plugin.row}`)
    lines.push(`      name: '${name}'`)
    if (plugin.config !== undefined) {
      lines.push('      config:')
      for (const [key, value] of Object.entries(plugin.config)) {
        lines.push(`        ${key}: ${value}`)
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

/** 生成 bundle 的 package.json(exports 覆盖每个行模块 + 客户端半边 + 展示资源)。 */
function renderManifest(packageName, version) {
  const clientPlugin = PLUGINS.find(plugin => plugin.short === CLIENT_PLUGIN)
  if (clientPlugin === undefined) throw new Error(`PLUGINS 缺少客户端半边宿主 ${CLIENT_PLUGIN}`)
  const exports = {
    '.': `./${CLIENT_PLUGIN}/${clientPlugin.entry}`,
    './client': `./${CLIENT_PLUGIN}/lib/client.js`,
    './package.json': './package.json',
    './locale/*.json': './locale/*.json',
    './icon': './icon.svg',
  }
  for (const plugin of PLUGINS) {
    exports[`./${plugin.short}`] = `./${plugin.short}/${plugin.entry}`
    exports[`./${plugin.short}/locale/*.json`] = `./${plugin.short}/locale/*.json`
    exports[`./${plugin.short}/icon`] = './icon.svg'
    exports[`./${plugin.short}/package.json`] = `./${plugin.short}/package.json`
  }
  return {
    name: packageName,
    version,
    private: true,
    type: 'module',
    description:
      'StarHub:DevOps 工作台(数据库 / SSH / Docker / Android / AI 助手)作为 DSH 组合包安装',
    exports,
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', inject: [...CLIENT_INJECT] },
    },
    files: [
      '*.js',
      'cordis.patch.yml',
      'icon.svg',
      'locale/*.json',
      ...PLUGINS.flatMap(plugin => [`${plugin.short}/lib/**`, `${plugin.short}/locale/*.json`]),
      'host-static/dist/**',
      'bridge/sidecar/**',
    ],
  }
}

/**
 * 把产物里客户端半边的注册 id 从**源包名**改写成 **bundle 包名**。
 *
 * `client.js` 由 tsdown 的 clientBundle 预设在构建期把源包名
 * (`@deepseek-ai/dsh-starhub-client-nav`)烙进 `__ModuleLoader__.load({ id })`、
 * 样式 `data-plugin` 标签与 tagId;而宿主给安装包下发的 boot 图行 id 是声明
 * `dsh.client` 的**安装包名**。加载器按行 id 等注册,两者不一致时脚本明明执行了
 * 却报 "loaded without registering",插件启用被整体回滚(见
 * packages/client/modules/src/client/system.ts 的 arrive())。
 * 只改产物:源码保持源包名(workspace 内开发与上游流仍按它解析)。
 * @param outDir - 组装产物目录。
 * @param packageName - bundle 包名(安装后的包名)。
 * @throws 当 client.js 里找不到源包名时(上游构建格式变了,需要跟进)。
 */
async function rewriteClientRegistrationId(outDir, packageName) {
  const sourceName = JSON.parse(await readFile(
    join(vendorRoot, 'packages', 'starhub', CLIENT_PLUGIN, 'package.json'), 'utf8',
  )).name
  if (sourceName === packageName) return
  const clientFile = join(outDir, CLIENT_PLUGIN, 'lib', 'client.js')
  const code = await readFile(clientFile, 'utf8')
  if (!code.includes(sourceName)) {
    throw new Error(`${CLIENT_PLUGIN}/lib/client.js 未含源包名 ${sourceName},注册 id 改写无从下手`)
  }
  await writeFile(clientFile, code.split(sourceName).join(packageName), 'utf8')
}

/**
 * 校验:每个 exports 目标存在、patch 可解析且每行 name 有对应导出。
 * 拼出来的包如果在安装后才炸(缺文件、非法 YAML),用户已经在插件页点过安装了,
 * 所以这里 fail loud 要趁早。
 */
async function assertBundle(outDir, manifest, patchText, packageName) {
  const problems = []
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath.includes('*')) continue
    const abs = join(outDir, target)
    if (!existsSync(abs)) problems.push(`exports["${subpath}"] 目标缺失: ${target}`)
  }
  // 分发包不带 sourcemap:体积占七成,且运行时要不到。漏一个就白打十几 MB,
  // 所以在组装期就拦住(CI 的 tar 内容校验是第二道)。
  for (const file of await listFilesRecursive(outDir)) {
    if (file.endsWith('.map')) problems.push(`产物里不应有 sourcemap: ${file.slice(outDir.length + 1)}`)
  }
  // 客户端半边必须按安装包名注册:boot 图按包名建行,加载器只认
  // `__ModuleLoader__.load({ id })` 里的同一个 id,不一致就是
  // "loaded without registering"(只在用户点启用时才炸,所以必须在组装期拦住)。
  const clientJs = await readFile(join(outDir, CLIENT_PLUGIN, 'lib', 'client.js'), 'utf8')
  const registered = /\b__ModuleLoader__\.load\(\s*\{\s*id:\s*"([^"]+)"/.exec(clientJs)
  if (registered === null) {
    problems.push(`${CLIENT_PLUGIN}/lib/client.js 没有 __ModuleLoader__.load 注册调用`)
  } else if (registered[1] !== packageName) {
    problems.push(`客户端注册 id 是 "${registered[1]}",应为安装包名 "${packageName}"`)
  }
  const yaml = loadYamlParser()
  if (yaml === null) {
    console.warn('[bundle] 未找到 js-yaml,patch 语法校验跳过')
  } else {
    let document
    try {
      document = yaml.load(patchText)
    } catch (error) {
      problems.push(`cordis.patch.yml 不是合法 YAML: ${error.message}`)
    }
    if (Array.isArray(document)) {
      const rows = document.flatMap(entry => (Array.isArray(entry?.insert) ? entry.insert : []))
      for (const row of rows) {
        const name = row?.name
        if (typeof name !== 'string') { problems.push(`行 ${row?.id} 缺少 name`); continue }
        const sub = name === packageName ? '.' : `./${name.slice(packageName.length + 1)}`
        if (manifest.exports[sub] === undefined) {
          problems.push(`行 ${row.id} 的模块 ${name} 没有对应 exports["${sub}"]`)
        }
      }
    } else {
      problems.push('cordis.patch.yml 顶层必须是数组')
    }
  }
  if (problems.length > 0) {
    throw new Error(`组装校验失败:\n  - ${problems.join('\n  - ')}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const version = options.version ?? JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version
  const rustSidecar = resolveRustSidecar(options.sidecarRust)

  // ── 前置校验:缺一项就 fail loud,不产出半套 ──
  const problems = []
  for (const plugin of PLUGINS) {
    const source = join(vendorRoot, 'packages', 'starhub', plugin.short)
    if (!existsSync(join(source, plugin.entry))) {
      problems.push(`插件产物缺失: packages/starhub/${plugin.short}/${plugin.entry}(先跑 npm run build:lib)`)
    }
  }
  if (!existsSync(join(vendorRoot, 'packages', 'starhub', CLIENT_PLUGIN, 'lib', 'client.js'))) {
    problems.push('客户端半边缺失: packages/starhub/client-nav/lib/client.js(先跑 npm run build:lib:client)')
  } else {
    // plugin:bundle 只组装不重 build,client.js 静默装旧代码是最阴的坑
    // (界面「改了但没生效」)。src 比产物新即 fail loud,逼一次重 build。
    const clientJs = join(vendorRoot, 'packages', 'starhub', CLIENT_PLUGIN, 'lib', 'client.js')
    let srcNewest = 0
    for (const file of await listFilesRecursive(join(vendorRoot, 'packages', 'starhub', CLIENT_PLUGIN, 'src'))) {
      srcNewest = Math.max(srcNewest, (await stat(file)).mtimeMs)
    }
    if (srcNewest > (await stat(clientJs)).mtimeMs) {
      problems.push(
        '客户端 client.js 比 src/ 旧(plugin:bundle 不自动重 build):先跑 ' +
        'pnpm --dir vendor/deepseek-harness --filter @deepseek-ai/dsh-starhub-client-nav run bundle')
    }
  }
  if (!existsSync(join(options.windowDist, 'index.html'))) {
    problems.push(`工作台 dist 缺失: ${options.windowDist}(先跑 npm run build:window)`)
  }
  if (!existsSync(rustSidecar)) {
    problems.push(`Rust sidecar 缺失: ${rustSidecar}(先跑 npm run sidecar-rust:build)`)
  }
  if (!existsSync(options.sidecarGo)) {
    problems.push(`Go sidecar 缺失: ${options.sidecarGo}(先跑 npm run sidecar:build)`)
  }
  if (problems.length > 0) {
    console.error('build-plugin-bundle: 前置校验失败:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  const manifest = renderManifest(options.name, version)
  const patchText = renderPatch(options.name)
  const distIndex = await readFile(join(options.windowDist, 'index.html'), 'utf8')
  if (!distIndex.includes('/starhub-react/assets/')) {
    console.error('build-plugin-bundle: 工作台 dist 未按 vite base /starhub-react/ 构建,host-static 会拒绝加载')
    process.exit(1)
  }

  console.log('[bundle] 组装计划:')
  console.log(`  产物      ${options.out}`)
  console.log(`  包名      ${options.name}@${version}`)
  console.log(`  插件行    ${PLUGINS.length} 个(纯 insert,不动上游行)`)
  console.log(`  客户端     ./client → ${CLIENT_PLUGIN}/lib/client.js`)
  console.log(`  工作台    ${options.windowDist} → host-static/dist(不含 sourcemap)`)
  console.log(`  sidecar   ${basename(rustSidecar)} + ${basename(options.sidecarGo)} → bridge/sidecar/`)
  console.log(`  资产名    starhub-dsh-plugin-${version}-${platformTag()}.tgz`)
  if (options.dryRun) {
    console.log('[bundle] --dry-run:不落盘')
    return
  }

  // ── 落盘:先清空产物目录,保证重跑刷新而不是留残留 ──
  await rm(options.out, { recursive: true, force: true })
  await mkdir(options.out, { recursive: true })

  for (const plugin of PLUGINS) {
    const source = join(vendorRoot, 'packages', 'starhub', plugin.short)
    // 同样不带 sourcemap:tsdown 给客户端半边与部分 host lib 产出 .map,
    // 它们会经 `files` 白名单进 tarball(实测 CI 上被内容校验抓出),而运行时不需要。
    await cp(join(source, 'lib'), join(options.out, plugin.short, 'lib'), {
      recursive: true,
      filter: entry => !entry.endsWith('.map'),
    })
    const packageJson = {
      name: `${options.name}/${plugin.short}`,
      version,
      private: true,
      type: 'module',
      description: plugin.description.zh,
      main: plugin.entry,
      exports: { '.': `./${plugin.entry}`, './locale/*.json': './locale/*.json', './icon': './icon.svg' },
    }
    await writeFile(
      join(options.out, plugin.short, 'package.json'),
      `${JSON.stringify(packageJson, undefined, 2)}\n`,
    )
    for (const [locale, title] of Object.entries(plugin.title)) {
      const dir = join(options.out, plugin.short, 'locale')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${locale}.json`), `${JSON.stringify({
        meta: { title, description: plugin.description[locale] },
      }, undefined, 2)}\n`)
    }
  }

  // 客户端注册 id 改写必须在 assertBundle 之前完成(自检会校验它)。
  await rewriteClientRegistrationId(options.out, options.name)

  // 工作台 dist:sourcemap 是开发产物(单次构建里占 ~七成体积),分发包不带。
  await cp(options.windowDist, join(options.out, 'host-static', 'dist'), {
    recursive: true,
    filter: source => !source.endsWith('.map'),
  })
  await mkdir(join(options.out, 'bridge', 'sidecar'), { recursive: true })
  await cp(rustSidecar, join(options.out, 'bridge', 'sidecar', SIDECAR_NAMES.rust))
  await cp(options.sidecarGo, join(options.out, 'bridge', 'sidecar', SIDECAR_NAMES.go))
  await chmodSidecars(join(options.out, 'bridge', 'sidecar'))

  await mkdir(join(options.out, 'locale'), { recursive: true })
  await writeFile(join(options.out, 'locale', 'zh.json'), `${JSON.stringify({
    meta: {
      title: 'StarHub',
      description: 'DevOps 工作台:数据库客户端、SSH/SFTP、Docker 面板、Android 真机与 AI 助手。',
    },
  }, undefined, 2)}\n`)
  await writeFile(join(options.out, 'locale', 'en.json'), `${JSON.stringify({
    meta: {
      title: 'StarHub',
      description: 'DevOps workbench: database clients, SSH/SFTP, Docker panel, Android devices, and an AI assistant.',
    },
  }, undefined, 2)}\n`)
  await writeFile(join(options.out, 'icon.svg'), ICON_SVG)
  await writeFile(join(options.out, 'cordis.patch.yml'), patchText)
  await writeFile(join(options.out, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

  await assertBundle(options.out, manifest, patchText, options.name)

  console.log('[bundle] 完成')
  if (options.pack) {
    const packed = await packTarball(options.out, version)
    console.log(`[bundle] tarball: ${packed}`)
    console.log('[bundle] 在 dsh 插件页「添加插件」里粘贴下面任一个:')
    console.log(`  本地文件  ${packed}`)
    const url = releaseAssetUrl(version, basename(packed))
    if (url !== null) console.log(`  Release   ${url}(推 tag 后由 plugin-bundle.yml 自动上传)`)
  } else {
    console.log('[bundle] 在 dsh 插件页「添加插件」里粘贴这个绝对路径:')
    console.log(`  ${options.out}`)
    console.log('[bundle] 注意:本地目录安装是 link,行模块的 @deepseek-ai/* 裸 import 解析不到,')
    console.log('         插件会 failed to import;要真装请用 --pack 出的 tarball 或已发布的包名。')
  }
}

/**
 * POSIX 上给两个 sidecar 加可执行位。
 *
 * Windows 的 exe 不关心权限位,但 Linux/macOS 上 tar 包解出来若没有 +x,桥 spawn
 * 会直接 EACCES——那是「装完工作台能开、工具全报错」级别的故障。
 * @param dir - sidecar 目录。
 */
async function chmodSidecars(dir) {
  if (process.platform === 'win32') return
  const { chmod } = await import('node:fs/promises')
  for (const file of await readdirSafe(dir)) {
    await chmod(join(dir, file), 0o755)
  }
}

/** 产物平台标记(资产名里必须带,因为包内是平台相关的二进制)。 */
function platformTag() {
  const os = { win32: 'win', linux: 'linux', darwin: 'mac' }[process.platform] ?? process.platform
  return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
}

/**
 * Release 资产 URL(推 tag 后由 `plugin-bundle.yml` 上传同名资产)。
 * @param version - 包版本(去掉前缀 v)。
 * @param assetName - 资产文件名。
 * @returns https URL,或在读不到 GitHub remote 时返回 null。
 */
function releaseAssetUrl(version, assetName) {
  const spawnSync = createRequire(import.meta.url)('node:child_process').spawnSync
  const remote = spawnSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' })
  const match = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(remote.stdout ?? '')
  if (match === null) return null
  const [, owner, repo] = match
  return `https://github.com/${owner}/${repo}/releases/download/v${version}/${assetName}`
}

/**
 * 用 npm pack 打 tarball,并改名成**带平台标记**的资产名。
 *
 * package.json 的 `files` 已覆盖 lib / dist / sidecar / locale / patch;`private: true`
 * 只挡发布,不挡 pack。包内是平台相关的二进制(两个 sidecar),所以资产名必须带
 * 平台:GitHub Release 上同一个 tag 只能有一个同名资产,不带平台会互相覆盖,而
 * 「粘贴的 URL」必须能唯一指到本平台那一份。
 * @param outDir - 组装好的 bundle 目录。
 * @param version - 包版本(资产名与 Release tag 都用它)。
 * @returns 生成的 .tgz 绝对路径。
 * @throws 当 npm pack 非零退出或未产出 tarball 时。
 */
async function packTarball(outDir, version) {
  const { spawnSync } = await import('node:child_process')
  const { rename } = await import('node:fs/promises')
  const before = new Set(await readdirSafe(repoRoot))
  // Windows 上 npm 是 .cmd,不经 shell 起不来;命令串里只有脚本自己算出的绝对路径。
  const packed = spawnSync(`npm pack --pack-destination ${JSON.stringify(repoRoot)}`, {
    cwd: outDir,
    encoding: 'utf8',
    shell: true,
  })
  if (packed.status !== 0) {
    throw new Error(`npm pack 失败:\n${packed.stdout ?? ''}\n${packed.stderr ?? ''}`)
  }
  const produced = (await readdirSafe(repoRoot)).filter(name => name.endsWith('.tgz') && !before.has(name))
  if (produced.length === 0) throw new Error('npm pack 未产出新的 .tgz')
  const source = join(repoRoot, produced[produced.length - 1])
  const assetName = `starhub-dsh-plugin-${version}-${platformTag()}.tgz`
  const target = join(repoRoot, assetName)
  await rm(target, { force: true })
  await rename(source, target)
  return target
}

/** 读目录项(不存在当空目录)。 */
async function readdirSafe(dir) {
  try {
    const { readdir } = await import('node:fs/promises')
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * 递归列出目录下的文件绝对路径(组装期自检用;目录不存在当空)。
 * @param dir - 起始目录。
 * @returns 文件绝对路径列表。
 */
async function listFilesRecursive(dir) {
  const files = []
  for (const entry of await readdirSafe(dir)) {
    const full = join(dir, entry)
    const kind = await pathKindOf(full)
    if (kind === 'dir') files.push(...await listFilesRecursive(full))
    else if (kind === 'file') files.push(full)
  }
  return files
}

/** `'dir' | 'file' | 'missing'`。 */
async function pathKindOf(path) {
  try {
    const { stat } = await import('node:fs/promises')
    const info = await stat(path)
    return info.isDirectory() ? 'dir' : 'file'
  } catch {
    return 'missing'
  }
}

// 作为脚本运行时才组装;被测试 import 时只导出纯函数(renderPatch / renderManifest)。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`build-plugin-bundle: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}

export { PLUGINS, CLIENT_PLUGIN, ICON_SVG, renderManifest, renderPatch, rewriteClientRegistrationId, SIDECAR_NAMES }
