/**
 * 新建/编辑连接对话框(壳内 React 小对话框,替代原整幅连接管理 iframe
 * overlay):类型下拉 + 公共字段(名称/主机/端口/用户名/密码)+ 各类型
 * 专有字段,提交走顶层帧 Tauri IPC(create_asset / update_asset /
 * delete_asset,与 src/services/asset.ts 同契约)。编辑模式从资产行预填,
 * 留空的密码/私钥字段不随更新提交(后端 merge 语义下保持原值),并多一个
 * 两步确认的删除入口。浏览器预览(无 Tauri IPC)只展示提示、禁用提交。
 *
 * SSH 认证三档与 Vue 版 SshConnectionForm.vue 对齐:password / key / mfa。
 * mfa 档写 `authMode:'mfa'` + `mfaEnabled:true` + `mfaPassword`(MFA 主密码,
 * 连接时另弹 TOTP 键盘交互;后端契约见 src-tauri/src/ssh/mod.rs 的
 * `SshConfig.kb_interactive` 与 src/services/ssh.ts 的 buildAuth/buildConfig)。
 *
 * 「测试连接」直连后端 test 命令(ssh 用 test_ssh_connection,db 用
 * db_<type>_test,docker 用 docker_test,kafka/nsq 用 broker_test),显示
 * 测试中/成功/失败原因;ssh 测试期间订阅 kb-interactive(内联验证码输入)
 * 与 hostkey-confirm(自动接受、不持久化)事件,与 Vue 版 onTestConnection 一致。
 */
import { useRef, useState } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { tauriInvoke, tauriListen } from './tauri.ts'
import type { RustAsset } from './store.ts'
import s from './settings/settings.module.css'

/** 对话框支持的连接类型(展示顺序即数组顺序);db 系经 config.dbType 区分。 */
const CONN_KINDS = [
  { kind: 'ssh', label: 'SSH', defaultPort: 22 },
  { kind: 'mysql', label: 'MySQL', defaultPort: 3306 },
  { kind: 'postgresql', label: 'PostgreSQL', defaultPort: 5432 },
  { kind: 'clickhouse', label: 'ClickHouse', defaultPort: 8123 },
  { kind: 'redis', label: 'Redis', defaultPort: 6379 },
  { kind: 'elasticsearch', label: 'Elasticsearch', defaultPort: 9200 },
  { kind: 'kafka', label: 'Kafka', defaultPort: 9092 },
  { kind: 'nsq', label: 'NSQ', defaultPort: 4150 },
  { kind: 'docker', label: 'Docker', defaultPort: 0 },
] as const

/** 连接类型 key(CONN_KINDS[].kind)。 */
type ConnKind = (typeof CONN_KINDS)[number]['kind']

/** 编辑模式:资产 → 对话框类型 key(db 资产按 config.dbType,缺省 mysql)。 */
function kindOfAsset(asset: RustAsset): ConnKind {
  if (asset.type === 'ssh') return 'ssh'
  if (asset.type === 'docker') return 'docker'
  const dbType = typeof asset.config.dbType === 'string' ? asset.config.dbType : 'mysql'
  const hit = CONN_KINDS.find(k => k.kind === dbType)
  return hit !== undefined ? hit.kind : 'mysql'
}

/** SSH 认证方式(与 Vue SshConnectionForm 的 authMode 对齐)。 */
type SshAuth = 'password' | 'key' | 'mfa'

/** test_ssh_connection 期间后端推送的 keyboard-interactive 事件负载。 */
interface KbInteractiveEvent {
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
  autoFill: Array<string | null>
}

/** 各后端 test 命令的返回契约(ok/message/elapsed_ms)。 */
interface TestResult {
  ok: boolean
  message?: string
  elapsed_ms?: number
}

/** 测试连接状态机:idle 不展示,testing/success/fail 各对应一行提示。 */
type TestStatus = 'idle' | 'testing' | 'success' | 'fail'

/** 字符串配置字段读取(非串归空)。 */
function str(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

/** 数值配置字段读取(非有限数归缺省)。 */
function num(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 字符串数组配置字段读取(非字符串数组归空;ES 的 addresses 多节点)。 */
function strList(config: Record<string, unknown>, key: string): string[] {
  const value = config[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** 对话框入参:打开状态由父层(overlay)控制,asset 非空进入编辑模式。 */
export interface NewConnectionDialogProps {
  /** 编辑目标;null = 新建。 */
  asset: RustAsset | null
  /** 关闭(取消 / 提交成功 / 删除成功后)。 */
  onClose: () => void
  /** 提交或删除成功后刷新资产列表。 */
  onSaved: () => void
}

/**
 * Render the small dsh-style connection dialog (create / edit / delete).
 * State initializes from `asset` on mount — the parent remounts the dialog
 * per target (key), so no prop-watch syncing is needed.
 * @param props - dialog target + close/save callbacks.
 * @returns the dialog markup.
 */
export function NewConnectionDialog({ asset, onClose, onSaved }: NewConnectionDialogProps) {
  const editing = asset !== null
  const preview = typeof window === 'undefined'
    || (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === undefined
  const [kind, setKind] = useState<ConnKind>(() => (asset === null ? 'ssh' : kindOfAsset(asset)))
  const [name, setName] = useState(() => asset?.name ?? '')
  const [host, setHost] = useState(() => (asset === null ? '' : str(asset.config, 'host')))
  const [port, setPort] = useState(() => {
    if (asset !== null) return num(asset.config, 'port', 22)
    return CONN_KINDS[0].defaultPort
  })
  const [username, setUsername] = useState(() => (asset === null ? '' : str(asset.config, 'username')))
  const [password, setPassword] = useState('')
  const [database, setDatabase] = useState(() => (asset === null ? '' : str(asset.config, 'database')))
  const [redisDb, setRedisDb] = useState(() => (asset === null ? 0 : num(asset.config, 'db', 0)))
  const [ssl, setSsl] = useState(() => asset?.config.ssl === true)
  /** Elasticsearch 端点形态(Vue DbConnectionForm 三态对齐):host / address / multi。 */
  const [esMode, setEsMode] = useState<'host' | 'address' | 'multi'>(() => {
    if (asset === null) return 'host'
    if (strList(asset.config, 'addresses').length > 0) return 'multi'
    if (str(asset.config, 'address') !== '') return 'address'
    return 'host'
  })
  /** ES Address URL 模式下的端点(单地址)。 */
  const [esAddress, setEsAddress] = useState(() => (asset === null ? '' : str(asset.config, 'address')))
  /** ES Multi Nodes 模式下的节点文本(每行一个,与 Vue esNodes 同契约)。 */
  const [esNodes, setEsNodes] = useState(() => (asset === null ? '' : strList(asset.config, 'addresses').join('\n')))
  const [sshAuth, setSshAuth] = useState<SshAuth>(() => {
    if (asset === null) return 'password'
    if (asset.config.authMode === 'mfa' || asset.config.mfaEnabled === true) return 'mfa'
    return asset.config.useKeyAuth === true || asset.config.authMode === 'key' ? 'key' : 'password'
  })
  const [mfaPassword, setMfaPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [privateKeyName, setPrivateKeyName] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [dockerTransport, setDockerTransport] = useState<'socket' | 'tcp'>(() =>
    asset?.config.dockerTransport === 'tcp' ? 'tcp' : 'socket')
  const [dockerAddress, setDockerAddress] = useState(() => {
    if (asset === null) return ''
    return str(asset.config, 'remoteHost') || str(asset.config, 'socketPath')
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testMessage, setTestMessage] = useState('')
  const [kbPrompt, setKbPrompt] = useState<KbInteractiveEvent | null>(null)
  const [kbAnswers, setKbAnswers] = useState<string[]>([])
  const testSessionIdRef = useRef('')
  const keyFileRef = useRef<HTMLInputElement | null>(null)

  /* v8 ignore next -- kind 恒取自 CONN_KINDS,find 必命中;回退仅是类型安全兜底 */
  const kindMeta = CONN_KINDS.find(k => k.kind === kind) ?? CONN_KINDS[0]
  const isDb = kind !== 'ssh' && kind !== 'docker'
  const needsUsername = kind === 'ssh' || kind === 'mysql' || kind === 'postgresql' || kind === 'clickhouse'
  const hasDatabase = kind === 'mysql' || kind === 'postgresql' || kind === 'clickhouse'
  /** 地址/端点有效性:docker 看 transport+地址;ES 看三态;其余看 host。 */
  const addressValid = kind === 'docker'
    ? dockerTransport === 'socket' || dockerAddress.trim() !== ''
    : kind === 'elasticsearch'
      ? (esMode === 'multi'
        ? esNodes.split('\n').map(s => s.trim()).filter(Boolean).length > 0
        : esMode === 'address' ? esAddress.trim() !== '' : host.trim() !== '')
      : host.trim() !== ''
  const canSubmit = !preview && !busy && name.trim() !== ''
    && addressValid
    && (!needsUsername || username.trim() !== '')
    && (kind !== 'ssh' || sshAuth !== 'key' || editing || privateKey !== '')
  // 测试连接不要求名称;其余必填与提交一致(私钥档新建必须先选文件)。
  const canTest = !preview && !busy
    && addressValid
    && (!needsUsername || username.trim() !== '')
    && (kind !== 'ssh' || sshAuth !== 'key' || editing || privateKey !== '')

  /** 切换类型(仅新建):带出缺省端口。 */
  const onKindChange = (next: ConnKind) => {
    setKind(next)
    const meta = CONN_KINDS.find(k => k.kind === next)
    if (meta !== undefined && meta.defaultPort > 0) setPort(meta.defaultPort)
  }

  /** 私钥文件选取(web FileReader,不经 fs 插件;2MB 上限与 embed 版一致)。 */
  const onKeyFile = (file: File | undefined) => {
    if (file === undefined) return
    if (file.size > 2 * 1024 * 1024) {
      setError('私钥文件超过 2MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      /* v8 ignore next -- readAsText 的 result 恒为 string */
      setPrivateKey(typeof reader.result === 'string' ? reader.result : '')
      setPrivateKeyName(file.name)
      setError('')
    }
    reader.onerror = () =>{  setError('私钥文件读取失败') }
    reader.readAsText(file)
  }

  /** 组装 create/update 的 config(编辑模式留空的密码/私钥不提交,保持原值)。 */
  const buildConfig = (): Record<string, unknown> => {
    if (kind === 'ssh') {
      if (sshAuth === 'mfa') {
        // 字段命名严格对齐 Vue SshConnectionForm.onSubmit 的 mfa 分支:
        // mfaEnabled + mfaPassword,主密码同时写入 password 作第一阶段认证。
        return {
          host: host.trim(),
          port,
          username: username.trim(),
          authMode: 'mfa',
          usePasswordAuth: true,
          useKeyAuth: false,
          mfaEnabled: true,
          password: mfaPassword !== '' ? mfaPassword : undefined,
          mfaPassword: mfaPassword !== '' ? mfaPassword : undefined,
        }
      }
      return {
        host: host.trim(),
        port,
        username: username.trim(),
        authMode: sshAuth,
        usePasswordAuth: sshAuth === 'password',
        useKeyAuth: sshAuth === 'key',
        password: password !== '' ? password : undefined,
        privateKey: sshAuth === 'key' && privateKey !== '' ? privateKey : undefined,
        passphrase: sshAuth === 'key' && passphrase !== '' ? passphrase : undefined,
      }
    }
    if (kind === 'docker') {
      return {
        dockerTransport,
        socketPath: dockerTransport === 'socket' ? (dockerAddress.trim() || '/var/run/docker.sock') : undefined,
        remoteHost: dockerTransport === 'tcp' ? dockerAddress.trim() : undefined,
      }
    }
    return {
      dbType: kind,
      host: host.trim(),
      port,
      username: username.trim() !== '' ? username.trim() : undefined,
      password: password !== '' ? password : undefined,
      database: hasDatabase && database.trim() !== '' ? database.trim() : undefined,
      db: kind === 'redis' ? redisDb : undefined,
      ssl,
      ...(kind === 'elasticsearch' && (esMode === 'address' || esMode === 'multi')
        ? {
          address: esMode === 'address' ? esAddress.trim() : undefined,
          addresses: esMode === 'multi'
            ? esNodes.split('\n').map(s => s.trim()).filter(Boolean)
            : undefined,
        }
        : {}),
    }
  }

  const onSubmit = async () => {
    /* v8 ignore next -- 提交按钮 disabled(!canSubmit)时已不可触发,防御性保留 */
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      if (editing) {
        await tauriInvoke('update_asset', { id: asset.id, params: { name: name.trim(), config: buildConfig() } })
      } else {
        await tauriInvoke('create_asset', {
          params: {
            type: kind === 'ssh' ? 'ssh' : kind === 'docker' ? 'docker' : 'db',
            name: name.trim(),
            group_id: null,
            config: buildConfig(),
            tags: [],
          },
        })
      }
      onSaved()
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async () => {
    /* v8 ignore next -- 删除按钮只在编辑模式渲染且 busy 时 disabled,防御性保留 */
    if (!editing || preview || busy) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      await tauriInvoke('delete_asset', { id: asset.id })
      onSaved()
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setConfirmingDelete(false)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 非 ssh 类型的测试连接请求(db 用 db_<type>_test,docker 用 docker_test,
   * kafka/nsq 用 broker_test;入参与 src/services/db.ts / docker.ts /
   * broker.ts 的 test 封装同契约)。
   */
  const buildTestRequest = (): { cmd: string; args: Record<string, unknown> } => {
    if (kind === 'docker') {
      return {
        cmd: 'docker_test',
        args: {
          params: {
            transport: dockerTransport,
            socketPath: dockerTransport === 'socket' ? (dockerAddress.trim() || '/var/run/docker.sock') : undefined,
            host: dockerTransport === 'tcp' ? dockerAddress.trim() : undefined,
          },
        },
      }
    }
    if (kind === 'kafka' || kind === 'nsq') {
      return {
        cmd: 'broker_test',
        args: { kind, params: { host: host.trim(), port, username: username.trim(), password, ssl } },
      }
    }
    const params: Record<string, unknown> = { host: host.trim(), port, password }
    let cmd: string
    switch (kind) {
      case 'mysql':
      case 'postgresql':
      case 'clickhouse':
        cmd = kind === 'postgresql' ? 'db_postgres_test' : `db_${kind}_test`
        params.username = username.trim()
        params.database = database.trim()
        params.ssl = ssl
        break
      case 'redis':
        cmd = 'db_redis_test'
        params.db = redisDb
        params.ssl = ssl
        break
      default:
        // elasticsearch:字段名对齐 ESConnInfo(useSSL + address/addresses)
        cmd = 'db_es_test'
        params.username = username.trim()
        params.useSSL = ssl
        if (esMode === 'address') params.address = esAddress.trim()
        else if (esMode === 'multi') params.addresses = esNodes.split('\n').map(s => s.trim()).filter(Boolean)
        break
    }
    return { cmd, args: { params } }
  }

  /** 应用 test 命令结果到状态行(成功/失败 + 耗时)。 */
  const applyTestResult = (result: TestResult) => {
    setTestStatus(result.ok ? 'success' : 'fail')
    const ms = result.elapsed_ms !== undefined ? ` (${result.elapsed_ms}ms)` : ''
    setTestMessage((result.message ?? (result.ok ? '连接成功' : '连接失败')) + ms)
  }

  /**
   * 测试连接(与 Vue 版 onTestConnection 一致):ssh 走 test_ssh_connection
   * 并订阅本次 testSessionId 的 kb-interactive(内联验证码输入)与
   * hostkey-confirm(自动接受、不持久化)事件;编辑模式密钥字段留空表示
   * 「保持不变」,后端没有可测的凭据,直接提示先输入。
   */
  const onTestConnection = async () => {
    /* v8 ignore next -- 测试按钮 disabled 时已不可触发,防御性保留 */
    if (!canTest || testStatus === 'testing') return
    setError('')
    if (kind === 'ssh' && editing) {
      if (sshAuth === 'password' && password === '') {
        setTestStatus('fail')
        setTestMessage('编辑模式下密码留空表示不修改;测试前请输入密码。')
        return
      }
      if (sshAuth === 'mfa' && mfaPassword === '') {
        setTestStatus('fail')
        setTestMessage('编辑模式下 MFA 主密码留空表示不修改;测试前请输入 MFA 主密码。')
        return
      }
      if (sshAuth === 'key' && privateKey === '') {
        setTestStatus('fail')
        setTestMessage('编辑模式下不选私钥表示不修改;测试前请选择私钥文件。')
        return
      }
    }
    setTestStatus('testing')
    setTestMessage('')
    let unlistenKb: (() => Promise<void>) | null = null
    let unlistenHostkey: (() => Promise<void>) | null = null
    try {
      if (kind === 'ssh') {
        const testSessionId = `test-${Date.now()}`
        testSessionIdRef.current = testSessionId
        unlistenKb = await tauriListen<KbInteractiveEvent>(
          `ssh:kb-interactive:${testSessionId}`,
          (payload) => {
            setKbAnswers(payload.autoFill.map(v => v ?? ''))
            setKbPrompt(payload)
          },
        )
        // 测试连接自动接受 host key(不持久化),与 Vue 版一致
        unlistenHostkey = await tauriListen(`ssh:hostkey-confirm:${testSessionId}`, () => {
          void tauriInvoke('ssh_hostkey_response', { id: testSessionId, allowed: true, persist: false })
        })
        // MFA 档用 mfaPassword 做主认证密码,并启用 keyboard-interactive
        const auth: Record<string, unknown> = sshAuth === 'key'
          ? { PrivateKey: { key: privateKey, passphrase: passphrase !== '' ? passphrase : null } }
          : { Password: sshAuth === 'mfa' ? mfaPassword : password }
        const config: Record<string, unknown> = {
          host: host.trim(),
          port,
          username: username.trim(),
          auth,
        }
        if (sshAuth === 'mfa') {
          config.kb_interactive = { enabled: true, password: mfaPassword !== '' ? mfaPassword : null }
        }
        applyTestResult(await tauriInvoke<TestResult>('test_ssh_connection', { config, testSessionId }))
      } else {
        const request = buildTestRequest()
        applyTestResult(await tauriInvoke<TestResult>(request.cmd, request.args))
      }
    } catch (e: unknown) {
      setTestStatus('fail')
      setTestMessage(e instanceof Error ? e.message : String(e))
    } finally {
      if (unlistenKb !== null) void unlistenKb()
      if (unlistenHostkey !== null) void unlistenHostkey()
      setKbPrompt(null)
      testSessionIdRef.current = ''
    }
  }

  /** 提交 keyboard-interactive 应答(MFA 测试连接期间的 TOTP 输入)。 */
  const onKbSubmit = () => {
    // 面板只在测试进行中渲染,此时 testSessionIdRef 已赋值
    void tauriInvoke('ssh_kb_response', { id: testSessionIdRef.current, responses: kbAnswers })
    setKbPrompt(null)
  }

  return (
    <div className={s.dialogBackdrop} role="presentation" onMouseDown={onClose}>
      <div
        className={s.dialogPanel}
        role="dialog"
        aria-label={editing ? '编辑连接' : '新建连接'}
        onMouseDown={(event) =>{  event.stopPropagation() }}
      >
        <div className={s.dialogHead}>
          <span className={s.dialogTitle}>{editing ? `编辑连接 · ${asset.name}` : '新建连接'}</span>
          <button type="button" className={s.iconButton} aria-label="关闭" onClick={onClose}>
            <IconCloseOutline16 size={14} />
          </button>
        </div>
        {preview && (
          <div className={s.hint}>浏览器预览模式:没有 StarHub 桌面端后端(Tauri IPC),请在桌面应用中管理连接。</div>
        )}
        <div className={s.formGrid}>
          <div className={s.formField}>
            <label className={s.fieldLabel} htmlFor="conn-kind">类型</label>
            <select
              id="conn-kind"
              className={s.select}
              value={kind}
              disabled={editing || preview}
              onChange={(event) =>{  onKindChange(event.target.value as ConnKind) }}
            >
              {CONN_KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </div>
          <div className={s.formField}>
            <label className={s.fieldLabel} htmlFor="conn-name">名称 *</label>
            <input
              id="conn-name"
              className={s.input}
              value={name}
              disabled={preview}
              placeholder="连接名称"
              onChange={(event) =>{  setName(event.target.value) }}
            />
          </div>
          {kind === 'docker' ? (
            <>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-docker-transport">连接方式</label>
                <select
                  id="conn-docker-transport"
                  className={s.select}
                  value={dockerTransport}
                  disabled={preview}
                  onChange={(event) =>{  setDockerTransport(event.target.value === 'tcp' ? 'tcp' : 'socket') }}
                >
                  <option value="socket">本机 Socket</option>
                  <option value="tcp">远程 TCP</option>
                </select>
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-docker-address">
                  {dockerTransport === 'tcp' ? '地址 *' : 'Socket 路径'}
                </label>
                <input
                  id="conn-docker-address"
                  className={s.input}
                  value={dockerAddress}
                  disabled={preview}
                  placeholder={dockerTransport === 'tcp' ? 'tcp://127.0.0.1:2375' : '/var/run/docker.sock'}
                  onChange={(event) =>{  setDockerAddress(event.target.value) }}
                />
              </div>
            </>
          ) : kind === 'elasticsearch' ? (
            <>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-es-mode">端点方式</label>
                <select
                  id="conn-es-mode"
                  className={s.select}
                  value={esMode}
                  disabled={preview}
                  onChange={(event) => {
                    const value = event.target.value
                    setEsMode(value === 'multi' ? 'multi' : value === 'address' ? 'address' : 'host')
                  }}
                >
                  <option value="host">Host / Port</option>
                  <option value="address">Address URL</option>
                  <option value="multi">Multi Nodes</option>
                </select>
              </div>
              {esMode === 'multi' ? (
                <div className={s.formField}>
                  <label className={s.fieldLabel} htmlFor="conn-es-nodes">节点地址 *</label>
                  <textarea
                    id="conn-es-nodes"
                    className={s.input}
                    rows={3}
                    value={esNodes}
                    disabled={preview}
                    placeholder={'http://node1:9200\nhttp://node2:9200'}
                    onChange={(event) =>{  setEsNodes(event.target.value) }}
                  />
                  <span className={s.fieldHint}>每行一个地址,支持轮询与故障转移</span>
                </div>
              ) : esMode === 'address' ? (
                <div className={s.formField}>
                  <label className={s.fieldLabel} htmlFor="conn-es-address">地址 *</label>
                  <input
                    id="conn-es-address"
                    className={s.input}
                    value={esAddress}
                    disabled={preview}
                    placeholder="http://127.0.0.1:9200"
                    onChange={(event) =>{  setEsAddress(event.target.value) }}
                  />
                </div>
              ) : (
                <>
                  <div className={s.formField}>
                    <label className={s.fieldLabel} htmlFor="conn-host">主机 *</label>
                    <input
                      id="conn-host"
                      className={s.input}
                      value={host}
                      disabled={preview}
                      placeholder="127.0.0.1"
                      onChange={(event) =>{  setHost(event.target.value) }}
                    />
                  </div>
                  <div className={s.formField}>
                    <label className={s.fieldLabel} htmlFor="conn-port">端口</label>
                    <input
                      id="conn-port"
                      className={s.input}
                      type="number"
                      value={port}
                      disabled={preview}
                      onChange={(event) =>{  setPort(Number(event.target.value) || kindMeta.defaultPort) }}
                    />
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-host">主机 *</label>
                <input
                  id="conn-host"
                  className={s.input}
                  value={host}
                  disabled={preview}
                  placeholder="127.0.0.1"
                  onChange={(event) =>{  setHost(event.target.value) }}
                />
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-port">端口</label>
                <input
                  id="conn-port"
                  className={s.input}
                  type="number"
                  value={port}
                  disabled={preview}
                  onChange={(event) =>{  setPort(Number(event.target.value) || kindMeta.defaultPort) }}
                />
              </div>
            </>
          )}
          {kind !== 'docker' && kind !== 'redis' && (
            <div className={s.formField}>
              <label className={s.fieldLabel} htmlFor="conn-username">
                用户名{needsUsername ? ' *' : ''}
              </label>
              <input
                id="conn-username"
                className={s.input}
                value={username}
                disabled={preview}
                onChange={(event) =>{  setUsername(event.target.value) }}
              />
            </div>
          )}
          {kind === 'ssh' && (
            <div className={s.formField}>
              <label className={s.fieldLabel} htmlFor="conn-ssh-auth">认证方式</label>
              <select
                id="conn-ssh-auth"
                className={s.select}
                value={sshAuth}
                disabled={preview}
                onChange={(event) => {
                  const value = event.target.value
                  setSshAuth(value === 'key' ? 'key' : value === 'mfa' ? 'mfa' : 'password')
                }}
              >
                <option value="password">密码</option>
                <option value="key">私钥</option>
                <option value="mfa">MFA/2FA(键盘交互)</option>
              </select>
            </div>
          )}
          {kind === 'ssh' && sshAuth === 'mfa' && (
            <>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-mfa-password">
                  MFA 主密码{editing ? '(留空保持不变)' : ''}
                </label>
                <input
                  id="conn-mfa-password"
                  className={s.input}
                  type="password"
                  value={mfaPassword}
                  disabled={preview}
                  onChange={(event) =>{  setMfaPassword(event.target.value) }}
                />
              </div>
              <div className={s.formField}>
                <span className={s.fieldHint}>
                  连接时将在主密码认证后弹出一次性验证码(TOTP)输入。
                </span>
              </div>
            </>
          )}
          {kind !== 'docker' && (kind !== 'ssh' || sshAuth === 'password') && (
            <div className={s.formField}>
              <label className={s.fieldLabel} htmlFor="conn-password">
                密码{editing ? '(留空保持不变)' : ''}
              </label>
              <input
                id="conn-password"
                className={s.input}
                type="password"
                value={password}
                disabled={preview}
                onChange={(event) =>{  setPassword(event.target.value) }}
              />
            </div>
          )}
          {kind === 'ssh' && sshAuth === 'key' && (
            <>
              <div className={s.formField}>
                <span className={s.fieldLabel}>私钥文件{editing ? '(不选保持不变)' : ''}</span>
                <div className={s.toolbar}>
                  <button
                    type="button"
                    className={s.btnSecondary}
                    disabled={preview}
                    /* v8 ignore next -- 隐藏 input 与本按钮同块渲染,ref 必已挂载 */
                    onClick={() => keyFileRef.current?.click()}
                  >
                    选择文件
                  </button>
                  <span className={s.fieldHint}>{privateKeyName !== '' ? privateKeyName : '未选择'}</span>
                </div>
                <input
                  ref={keyFileRef}
                  type="file"
                  hidden
                  aria-label="私钥文件"
                  onChange={(event) =>{  onKeyFile(event.target.files?.[0]) }}
                />
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-passphrase">私钥口令(可空)</label>
                <input
                  id="conn-passphrase"
                  className={s.input}
                  type="password"
                  value={passphrase}
                  disabled={preview}
                  onChange={(event) =>{  setPassphrase(event.target.value) }}
                />
              </div>
            </>
          )}
          {hasDatabase && (
            <div className={s.formField}>
              <label className={s.fieldLabel} htmlFor="conn-database">数据库(可空)</label>
              <input
                id="conn-database"
                className={s.input}
                value={database}
                disabled={preview}
                placeholder={kind === 'postgresql' ? 'postgres' : ''}
                onChange={(event) =>{  setDatabase(event.target.value) }}
              />
            </div>
          )}
          {kind === 'redis' && (
            <div className={s.formField}>
              <label className={s.fieldLabel} htmlFor="conn-redis-db">DB 索引</label>
              <input
                id="conn-redis-db"
                className={s.input}
                type="number"
                value={redisDb}
                disabled={preview}
                onChange={(event) =>{  setRedisDb(Number(event.target.value) || 0) }}
              />
            </div>
          )}
          {isDb && (
            <div className={s.formField}>
              <span className={s.fieldLabel}>SSL</span>
              <label className={s.fieldHint}>
                <input
                  type="checkbox"
                  checked={ssl}
                  disabled={preview}
                  onChange={(event) =>{  setSsl(event.target.checked) }}
                />
                {' '}使用 SSL/TLS 连接
              </label>
            </div>
          )}
        </div>
        {error !== '' && <div className={s.errorText}>{error}</div>}
        {testStatus !== 'idle' && (
          <div
            className={testStatus === 'success' ? s.testOk : testStatus === 'fail' ? s.testFail : s.testPending}
            role="status"
          >
            {testStatus === 'testing' ? '测试中…' : testMessage}
          </div>
        )}
        {kbPrompt !== null && (
          <div className={s.kbPanel}>
            {kbPrompt.instructions !== '' && <div className={s.fieldHint}>{kbPrompt.instructions}</div>}
            {kbPrompt.prompts.map((prompt, index) => (
              <div className={s.formField} key={`${index}-${prompt.prompt}`}>
                <label className={s.fieldLabel} htmlFor={`kb-answer-${index}`}>
                  {prompt.prompt !== '' ? prompt.prompt : '验证码'}
                </label>
                <input
                  id={`kb-answer-${index}`}
                  className={s.input}
                  type={prompt.echo ? 'text' : 'password'}
                  value={kbAnswers[index] ?? ''}
                  onChange={(event) => {
                    const next = [...kbAnswers]
                    next[index] = event.target.value
                    setKbAnswers(next)
                  }}
                />
              </div>
            ))}
            <button type="button" className={s.btnPrimary} onClick={onKbSubmit}>提交验证码</button>
          </div>
        )}
        <div className={s.actionRow}>
          {editing && (
            <button
              type="button"
              className={s.btnDanger}
              disabled={preview || busy}
              onClick={() => void onDelete()}
            >
              {confirmingDelete ? '确认删除?' : '删除连接'}
            </button>
          )}
          <span className={s.spacer} />
          <button
            type="button"
            className={s.btnOutline}
            disabled={!canTest || testStatus === 'testing'}
            onClick={() => void onTestConnection()}
          >
            {testStatus === 'testing' ? '测试中…' : '测试连接'}
          </button>
          <button type="button" className={s.btnSecondary} disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className={s.btnPrimary} disabled={!canSubmit} onClick={() => void onSubmit()}>
            {busy ? '保存中…' : editing ? '保存' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
