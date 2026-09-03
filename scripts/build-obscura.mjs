// build-obscura.mjs — cross-platform orchestrator for the Obscura headless
// browser engine (vendor/obscura submodule). Invoked by `npm run obscura:build`
// from beforeBuildCommand (CI: windows/linux/linux-legacy) and dev-dsh-shell.
//
// Windows: shell out to scripts/build-obscura.bat (loads MSVC vcvars + pins
// CARGO_TARGET_DIR to the USERPROFILE drive so the v8 build script skips a
// cross-drive gn_root symlink that requires privilege). macOS/Linux: run cargo
// directly. Then stage `obscura` (+ triple-named externalBin) into sidecar/bin
// and sync into src-tauri target profiles, mirroring build-sidecar.mjs.
//
// Only the `obscura` binary is bundled: `obscura-worker` exists solely for the
// parallel `scrape` CLI command, which StarHub never invokes.

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const obscuraDir = join(projectRoot, 'vendor', 'obscura')
const binDir = join(projectRoot, 'sidecar', 'bin')
const release = process.argv.includes('--release')
const hostOS = ({ win32: 'windows', darwin: 'darwin' }[process.platform] ?? 'linux')
const hostArch = ({ x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch)
const targetOS = hostOS
const targetArch = hostArch

const outputName = `obscura${targetOS === 'windows' ? '.exe' : ''}`

function rustTargetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE
  const triples = {
    'windows/amd64': 'x86_64-pc-windows-msvc',
    'windows/arm64': 'aarch64-pc-windows-msvc',
    'darwin/amd64': 'x86_64-apple-darwin',
    'darwin/arm64': 'aarch64-apple-darwin',
    'linux/amd64': 'x86_64-unknown-linux-gnu',
    'linux/arm64': 'aarch64-unknown-linux-gnu'
  }
  const triple = triples[`${targetOS}/${targetArch}`]
  if (!triple) throw new Error(`Unsupported Obscura target: ${targetOS}/${targetArch}`)
  return triple
}

function ensureSubmodule() {
  // vendor/obscura 是 git submodule。若 clone 未带 --recurse-submodules(或 CI
  // checkout 未配 submodules),Cargo.toml 不存在,先 init 再构建。
  const marker = join(obscuraDir, 'Cargo.toml')
  if (existsSync(marker)) return
  console.log('vendor/obscura 未检出,初始化 git submodule...')
  const r = spawnSync('git',
    ['submodule', 'update', '--init', '--recursive', 'vendor/obscura'],
    { cwd: projectRoot, stdio: 'inherit', shell: false })
  if (r.error) throw r.error
  if (r.status !== 0 || !existsSync(marker)) {
    throw new Error('vendor/obscura submodule 初始化失败')
  }
}

function build() {
  console.log(`Building obscura engine (render feature) for ${targetOS}/${targetArch}...`)
  if (targetOS === 'windows') {
    // .bat handles MSVC env + CARGO_TARGET_DIR; output at USERPROFILE target.
    const r = spawnSync('cmd', ['/c', join(scriptDir, 'build-obscura.bat')], {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false
    })
    if (r.error) throw r.error
    if (r.status !== 0) process.exit(r.status ?? 1)
  } else {
    const r = spawnSync('cargo',
      ['build', '--release', '-p', 'obscura-cli', '--bin', 'obscura', '--features', 'render'],
      {
        cwd: obscuraDir,
        env: { ...process.env, CARGO_INCREMENTAL: '0', CARGO_BUILD_JOBS: '2' },
        stdio: 'inherit',
        shell: false
      })
    if (r.error) throw r.error
    if (r.status !== 0) process.exit(r.status ?? 1)
  }
}

function builtBinaryPath() {
  if (targetOS === 'windows') {
    const root = process.env.CARGO_TARGET_DIR || join(process.env.USERPROFILE, '.starhub', 'obscura-target')
    return join(root, 'release', outputName)
  }
  return join(obscuraDir, 'target', 'release', outputName)
}

function ensureExecutable(p) {
  if (targetOS !== 'windows') chmodSync(p, 0o755)
}

mkdirSync(binDir, { recursive: true })
ensureSubmodule()
build()

const builtPath = builtBinaryPath()
if (!existsSync(builtPath)) throw new Error(`obscura build output not found: ${builtPath}`)

const outputPath = join(binDir, outputName)
copyFileSync(builtPath, outputPath)
ensureExecutable(outputPath)
console.log(`Obscura staged: ${outputPath}`)

const triple = rustTargetTriple()
const bundledPath = join(binDir, `obscura-${triple}${targetOS === 'windows' ? '.exe' : ''}`)
copyFileSync(builtPath, bundledPath)
ensureExecutable(bundledPath)
console.log(`Tauri external binary: ${bundledPath}`)

const targetProfiles = release ? ['release', 'debug'] : ['debug']
for (const profile of targetProfiles) {
  const targetDir = join(projectRoot, 'src-tauri', 'target', profile)
  if (existsSync(targetDir)) {
    const syncedPath = join(targetDir, outputName)
    copyFileSync(builtPath, syncedPath)
    ensureExecutable(syncedPath)
    console.log(`Obscura synced: ${syncedPath}`)
  }
}

console.log(`Obscura built: ${outputPath}`)
