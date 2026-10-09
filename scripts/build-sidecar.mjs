import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const sidecarDir = join(projectRoot, 'sidecar')
const binDir = join(sidecarDir, 'bin')
const release = process.argv.includes('--release')
const hostOS = ({ win32: 'windows', darwin: 'darwin' }[process.platform] ?? 'linux')
const hostArch = ({ x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch)
const targetOS = process.env.GOOS || hostOS
const targetArch = process.env.GOARCH || hostArch
const canExecuteTarget = targetOS === hostOS && targetArch === hostArch
const outputName = `starhub-sidecar${targetOS === 'windows' ? '.exe' : ''}`
const outputPath = join(binDir, outputName)
const ldflags = ['-s', '-w']
const requiredMethods = [
  'db.mysql.getTableMeta',
  'db.mysql.getTableData',
  'db.postgres.connect',
  'db.clickhouse.getTableMeta',
  'broker.kafka.overview',
  'broker.nsq.overview',
  'file.csv.open',
  'file.csv.readSheet',
  'file.csv.writeCells',
  'file.csv.save',
  'file.csv.removeDuplicates'
]

function verifySidecar(binaryPath) {
  if (!canExecuteTarget) {
    console.log(`Skipping execution check for cross-compiled sidecar: ${targetOS}/${targetArch}`)
    return
  }

  const verification = spawnSync(binaryPath, [], {
    input: '{"id":"build-check","method":"version","params":{}}\n',
    encoding: 'utf8',
    // Linux builds may execute the freshly linked binary from a bind-mounted
    // workspace (Docker/WSL), where the first launch can be noticeably slower.
    timeout: 30000
  })
  if (verification.error || verification.status !== 0) {
    throw new Error(`Sidecar verification failed for ${binaryPath}: ${verification.error?.message || verification.stderr}`)
  }

  const response = JSON.parse(verification.stdout.trim())
  const info = response.result
  if (info?.protocolVersion !== 2) {
    throw new Error(`Sidecar protocol mismatch for ${binaryPath}: ${info?.protocolVersion ?? 'missing'}`)
  }
  const missing = requiredMethods.filter(method => !info.methods?.includes(method))
  if (missing.length > 0) {
    throw new Error(`Sidecar is missing required methods: ${missing.join(', ')}`)
  }
}

function ensureExecutable(binaryPath) {
  if (targetOS !== 'windows') chmodSync(binaryPath, 0o755)
}

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
  if (!triple) {
    throw new Error(`Unsupported Sidecar target: ${targetOS}/${targetArch}`)
  }
  return triple
}

if (release && targetOS === 'windows') {
  ldflags.push('-H', 'windowsgui')
}

mkdirSync(binDir, { recursive: true })
console.log(`Building sidecar for ${targetOS}/${targetArch}...`)

const result = spawnSync(
  'go',
  ['build', '-ldflags', ldflags.join(' '), '-o', outputPath, '.'],
  {
    cwd: sidecarDir,
    env: { ...process.env, CGO_ENABLED: '0' },
    stdio: 'inherit'
  }
)

if (result.error) {
  throw result.error
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
ensureExecutable(outputPath)
verifySidecar(outputPath)

const extension = targetOS === 'windows' ? '.exe' : ''
const bundledPath = join(binDir, `starhub-sidecar-${rustTargetTriple()}${extension}`)
copyFileSync(outputPath, bundledPath)
ensureExecutable(bundledPath)
verifySidecar(bundledPath)
console.log(`Target-tagged sidecar verified: ${bundledPath}`)

console.log(`Sidecar built: ${outputPath}`)
