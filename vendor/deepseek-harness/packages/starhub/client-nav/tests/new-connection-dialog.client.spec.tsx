// @vitest-environment jsdom
/**
 * NewConnectionDialog(壳内连接小对话框):新建(create_asset 契约)/编辑
 * (预填 + 留空密码不提交)/删除两步确认/错误与 busy 态/浏览器预览禁用。
 * IPC 走 window.__TAURI_INTERNALS__ stub,断言与 src/services/asset.ts
 * 相同的 create_asset/update_asset/delete_asset 入参形态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NewConnectionDialog } from '../src/client/NewConnectionDialog.tsx'
import type { RustAsset } from '../src/client/store.ts'

/** jsdom 全局下的 Tauri IPC stub:按命令路由到 handlers。 */
function stubTauriInternals(handlers: Record<string, (args?: unknown) => unknown>): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: unknown) => {
      const handler = handlers[cmd]
      if (handler === undefined) return Promise.reject(new Error(`unexpected command: ${cmd}`))
      return Promise.resolve(handler(args))
    },
  }
  return () => {
    if (prev === undefined) delete w.__TAURI_INTERNALS__
    else w.__TAURI_INTERNALS__ = prev
  }
}

/** 构造一个完整 RustAsset(编辑模式预填用)。 */
function makeAsset(over: Partial<RustAsset> & { config: Record<string, unknown> }): RustAsset {
  return {
    id: 'a1', type: 'ssh', name: 'web-1', group_id: null, key_id: null,
    tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
    ...over,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('NewConnectionDialog create', () => {
  it('creates an ssh password asset with the embed-compatible config contract', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: args => create(args) })
    const onClose = vi.fn()
    const onSaved = vi.fn()
    try {
      render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={onSaved} />)
      // 缺 name/host/username → 创建禁用
      expect(screen.getByText('创建').hasAttribute('disabled')).toBe(true)
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'web-1' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: '10.0.0.5' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'deploy' } })
      fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() =>{  expect(onClose).toHaveBeenCalledTimes(1) })
      expect(onSaved).toHaveBeenCalledTimes(1)
      expect(create).toHaveBeenCalledWith({
        params: {
          type: 'ssh',
          name: 'web-1',
          group_id: null,
          config: {
            host: '10.0.0.5', port: 22, username: 'deploy',
            authMode: 'password', usePasswordAuth: true, useKeyAuth: false,
            password: 'pw', privateKey: undefined, passphrase: undefined,
          },
          tags: [],
        },
      })
    } finally {
      restore()
    }
  })

  it('switches kind to mysql (default port) and submits a db asset', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: args => create(args) })
    const onClose = vi.fn()
    try {
      render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'mysql' } })
      expect((screen.getByLabelText<HTMLInputElement>('端口')).value).toBe('3306')
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'orders' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'db.internal' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'root' } })
      fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw' } })
      // 端口清空回退缺省值,再改成自定义端口
      fireEvent.change(screen.getByLabelText('端口'), { target: { value: '' } })
      expect((screen.getByLabelText<HTMLInputElement>('端口')).value).toBe('3306')
      fireEvent.change(screen.getByLabelText('端口'), { target: { value: '3307' } })
      fireEvent.change(screen.getByLabelText('数据库(可空)'), { target: { value: 'shop' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() =>{  expect(onClose).toHaveBeenCalledTimes(1) })
      const args = create.mock.calls[0]![0] as { params: { type: string; config: Record<string, unknown> } }
      expect(args.params.type).toBe('db')
      expect(args.params.config).toMatchObject({
        dbType: 'mysql', host: 'db.internal', port: 3307, username: 'root', password: 'pw', database: 'shop', ssl: false,
      })
    } finally {
      restore()
    }
  })

  it('submits a redis asset with db index and no username field', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: args => create(args) })
    const onClose = vi.fn()
    try {
      render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'redis' } })
      expect(screen.queryByLabelText(/用户名/)).toBeNull()
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'cache' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: '127.0.0.1' } })
      fireEvent.change(screen.getByLabelText('DB 索引'), { target: { value: '2' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() =>{  expect(onClose).toHaveBeenCalledTimes(1) })
      const args = create.mock.calls[0]![0] as { params: { config: Record<string, unknown> } }
      expect(args.params.config).toMatchObject({ dbType: 'redis', port: 6379, db: 2 })
      expect('username' in args.params.config ? args.params.config.username : undefined).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('submits a docker tcp asset and a socket asset with the default path', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: args => create(args) })
    try {
      const onClose1 = vi.fn()
      const view = render(<NewConnectionDialog asset={null} onClose={onClose1} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'docker' } })
      // socket 模式:地址留空 → 缺省 /var/run/docker.sock
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'local-docker' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() =>{  expect(onClose1).toHaveBeenCalledTimes(1) })
      expect((create.mock.calls[0]![0] as { params: { config: Record<string, unknown> } }).params.config)
        .toMatchObject({ dockerTransport: 'socket', socketPath: '/var/run/docker.sock' })
      view.unmount()
      const onClose2 = vi.fn()
      render(<NewConnectionDialog asset={null} onClose={onClose2} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'docker' } })
      fireEvent.change(screen.getByLabelText('连接方式'), { target: { value: 'tcp' } })
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'remote-docker' } })
      fireEvent.change(screen.getByLabelText('地址 *'), { target: { value: 'tcp://10.0.0.9:2375' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() =>{  expect(onClose2).toHaveBeenCalledTimes(1) })
      expect((create.mock.calls[1]![0] as { params: { config: Record<string, unknown> } }).params.config)
        .toMatchObject({ dockerTransport: 'tcp', remoteHost: 'tcp://10.0.0.9:2375' })
    } finally {
      restore()
    }
  })

  it('keeps the dialog open and shows the error when create fails', async () => {
    let calls = 0
    const restore = stubTauriInternals({
      create_asset: () => {
        calls += 1
        if (calls === 1) throw 'raw string failure'
        throw new Error('dup name')
      },
    })
    const onClose = vi.fn()
    try {
      render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'x' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'h' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'u' } })
      fireEvent.click(screen.getByText('创建'))
      // 非 Error 抛出走 String(e) 分支
      expect(await screen.findByText('raw string failure')).toBeTruthy()
      fireEvent.click(screen.getByText('创建'))
      expect(await screen.findByText('dup name')).toBeTruthy()
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})

describe('NewConnectionDialog edit / delete', () => {
  it('prefills from the asset, omits a blank password on update and disables the kind select', async () => {
    const update = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ update_asset: args => update(args) })
    const onClose = vi.fn()
    try {
      const asset = makeAsset({ config: { host: '10.0.0.5', port: 2222, username: 'deploy' } })
      render(<NewConnectionDialog asset={asset} onClose={onClose} onSaved={() => {}} />)
      expect((screen.getByLabelText<HTMLSelectElement>('类型')).disabled).toBe(true)
      expect((screen.getByLabelText<HTMLInputElement>('名称 *')).value).toBe('web-1')
      expect((screen.getByLabelText<HTMLInputElement>('端口')).value).toBe('2222')
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'web-1b' } })
      fireEvent.click(screen.getByText('保存'))
      await vi.waitFor(() =>{  expect(onClose).toHaveBeenCalledTimes(1) })
      const args = update.mock.calls[0]![0] as { id: string; params: { name: string; config: Record<string, unknown> } }
      expect(args.id).toBe('a1')
      expect(args.params.name).toBe('web-1b')
      // 密码留空 → 不提交(后端 merge 保持原值)
      expect(args.params.config.password).toBeUndefined()
      expect(args.params.config.host).toBe('10.0.0.5')
    } finally {
      restore()
    }
  })

  it('deletes through the two-step confirm and keeps the dialog on failure', async () => {
    let calls = 0
    const restore = stubTauriInternals({
      delete_asset: () => {
        calls += 1
        if (calls === 1) throw 'delete raw'
        if (calls === 2) throw new Error('delete Error')
        return null
      },
    })
    const onClose = vi.fn()
    try {
      render(<NewConnectionDialog asset={makeAsset({ config: {} })} onClose={onClose} onSaved={() => {}} />)
      fireEvent.click(screen.getByText('删除连接'))
      expect(screen.getByText('确认删除?')).toBeTruthy()
      fireEvent.click(screen.getByText('确认删除?'))
      expect(await screen.findByText('delete raw')).toBeTruthy()
      // 失败后回到未确认态;第二次失败走 Error 分支
      fireEvent.click(screen.getByText('删除连接'))
      fireEvent.click(screen.getByText('确认删除?'))
      expect(await screen.findByText('delete Error')).toBeTruthy()
      fireEvent.click(screen.getByText('删除连接'))
      fireEvent.click(screen.getByText('确认删除?'))
      await vi.waitFor(() =>{  expect(onClose).toHaveBeenCalledTimes(1) })
    } finally {
      restore()
    }
  })

  it('detects key-auth assets and the broker dbType for the kind select', () => {
    render(<NewConnectionDialog
      asset={makeAsset({ config: { authMode: 'key' } })}
      onClose={() => {}}
      onSaved={() => {}}
    />)
    expect((screen.getByLabelText<HTMLSelectElement>('认证方式')).value).toBe('key')
    cleanup()
    render(<NewConnectionDialog
      asset={makeAsset({ type: 'db', config: { dbType: 'kafka', host: 'k', port: 9092 } })}
      onClose={() => {}}
      onSaved={() => {}}
    />)
    expect((screen.getByLabelText<HTMLSelectElement>('类型')).value).toBe('kafka')
    cleanup()
    // 未知 dbType → 回退 mysql
    render(<NewConnectionDialog
      asset={makeAsset({ type: 'db', config: { dbType: 'oracle' } })}
      onClose={() => {}}
      onSaved={() => {}}
    />)
    expect((screen.getByLabelText<HTMLSelectElement>('类型')).value).toBe('mysql')
  })

  it('detects docker assets and prefills tcp/socket transport fields', () => {
    render(<NewConnectionDialog
      asset={makeAsset({ type: 'docker', config: { dockerTransport: 'tcp', remoteHost: 'tcp://10.0.0.9:2375' } })}
      onClose={() => {}}
      onSaved={() => {}}
    />)
    expect((screen.getByLabelText<HTMLSelectElement>('类型')).value).toBe('docker')
    expect((screen.getByLabelText<HTMLSelectElement>('连接方式')).value).toBe('tcp')
    expect((screen.getByLabelText<HTMLInputElement>('地址 *')).value).toBe('tcp://10.0.0.9:2375')
    cleanup()
    render(<NewConnectionDialog
      asset={makeAsset({ type: 'docker', config: { dockerTransport: 'socket', socketPath: '/run/custom.sock' } })}
      onClose={() => {}}
      onSaved={() => {}}
    />)
    expect((screen.getByLabelText<HTMLSelectElement>('连接方式')).value).toBe('socket')
    expect((screen.getByLabelText<HTMLInputElement>('Socket 路径')).value).toBe('/run/custom.sock')
    cleanup()
    // db 资产缺 dbType → 回退 mysql
    render(<NewConnectionDialog
      asset={makeAsset({ type: 'db', config: { host: 'h' } })}
      onClose={() => {}}
      onSaved={() => {}}
    />)
    expect((screen.getByLabelText<HTMLSelectElement>('类型')).value).toBe('mysql')
  })
})

describe('NewConnectionDialog preview / misc', () => {
  it('disables inputs and shows the preview hint without Tauri internals', () => {
    render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
    expect(screen.getByText(/浏览器预览模式/)).toBeTruthy()
    expect((screen.getByLabelText<HTMLInputElement>('名称 *')).disabled).toBe(true)
    expect(screen.getByText('创建').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('测试连接').hasAttribute('disabled')).toBe(true)
  })

  it('closes via the header close button, the backdrop and the cancel button', () => {
    const onClose = vi.fn()
    const view = render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={() => {}} />)
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(view.container.querySelector('[role="presentation"]')!)
    expect(onClose).toHaveBeenCalledTimes(2)
    // panel 内 mousedown 不冒泡关闭
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByText('取消'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('loads a private key file through FileReader and submits key auth', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: args => create(args) })
    const onClose = vi.fn()
    try {
      render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'key' } })
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'k1' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'h' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'u' } })
      // 未选私钥 → 创建禁用
      expect(screen.getByText('创建').hasAttribute('disabled')).toBe(true)
      // 「选择文件」按钮触发隐藏 input 的 click
      fireEvent.click(screen.getByText('选择文件'))
      const file = new File(['---KEY---'], 'id_rsa', { type: 'text/plain' })
      fireEvent.change(screen.getByLabelText('私钥文件'), { target: { files: [file] } })
      await act(async () => { await Promise.resolve() })
      await screen.findByText('id_rsa')
      fireEvent.change(screen.getByLabelText('私钥口令(可空)'), { target: { value: 'pp' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() =>{  expect(onClose).toHaveBeenCalledTimes(1) })
      const config = (create.mock.calls[0]![0] as { params: { config: Record<string, unknown> } }).params.config
      expect(config).toMatchObject({ authMode: 'key', useKeyAuth: true, privateKey: '---KEY---', passphrase: 'pp' })
    } finally {
      restore()
    }
  })

  it('rejects an oversized private key file', async () => {
    render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
    fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'key' } })
    // 空文件列表 → no-op
    fireEvent.change(screen.getByLabelText('私钥文件'), { target: { files: [] } })
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.pem')
    fireEvent.change(screen.getByLabelText('私钥文件'), { target: { files: [big] } })
    expect(await screen.findByText('私钥文件超过 2MB')).toBeTruthy()
  })

  it('shows an error when the private key file fails to read', async () => {
    class FailingReader {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsText() {
        this.onerror?.()
      }
    }
    vi.stubGlobal('FileReader', FailingReader)
    try {
      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'key' } })
      const file = new File(['x'], 'id_rsa', { type: 'text/plain' })
      fireEvent.change(screen.getByLabelText('私钥文件'), { target: { files: [file] } })
      expect(await screen.findByText('私钥文件读取失败')).toBeTruthy()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('switches auth back to password from key', () => {
    render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
    fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'key' } })
    expect(screen.queryByLabelText(/密码/)).toBeNull()
    fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'password' } })
    expect(screen.getByLabelText(/密码/)).toBeTruthy()
  })
})

describe('NewConnectionDialog ssh mfa', () => {
  it('creates an ssh mfa asset with mfaEnabled/mfaPassword (Vue field contract)', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: args => create(args) })
    const onClose = vi.fn()
    try {
      render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'mfa' } })
      expect(screen.getByText(/一次性验证码/)).toBeTruthy()
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'mfa-1' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: '10.0.0.7' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'ops' } })
      fireEvent.change(screen.getByLabelText(/MFA 主密码/), { target: { value: 'mpw' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() =>{  expect(onClose).toHaveBeenCalledTimes(1) })
      expect(create).toHaveBeenCalledWith({
        params: {
          type: 'ssh',
          name: 'mfa-1',
          group_id: null,
          config: {
            host: '10.0.0.7', port: 22, username: 'ops',
            authMode: 'mfa', usePasswordAuth: true, useKeyAuth: false,
            mfaEnabled: true, password: 'mpw', mfaPassword: 'mpw',
          },
          tags: [],
        },
      })
    } finally {
      restore()
    }
  })

  it('prefills mfa from authMode or mfaEnabled and omits a blank mfa password on update', async () => {
    const update = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ update_asset: args => update(args) })
    try {
      const onClose1 = vi.fn()
      render(<NewConnectionDialog
        asset={makeAsset({ config: { authMode: 'mfa', host: 'h1', username: 'u' } })}
        onClose={onClose1}
        onSaved={() => {}}
      />)
      expect((screen.getByLabelText<HTMLSelectElement>('认证方式')).value).toBe('mfa')
      fireEvent.click(screen.getByText('保存'))
      await vi.waitFor(() =>{  expect(onClose1).toHaveBeenCalledTimes(1) })
      const config = (update.mock.calls[0]![0] as { params: { config: Record<string, unknown> } }).params.config
      expect(config).toMatchObject({ authMode: 'mfa', mfaEnabled: true, usePasswordAuth: true })
      // MFA 主密码留空 → 不提交(后端 merge 保持原值)
      expect(config.password).toBeUndefined()
      expect(config.mfaPassword).toBeUndefined()
      cleanup()
      // mfaEnabled: true 单独存在也识别为 mfa 档
      render(<NewConnectionDialog
        asset={makeAsset({ config: { mfaEnabled: true } })}
        onClose={() => {}}
        onSaved={() => {}}
      />)
      expect((screen.getByLabelText<HTMLSelectElement>('认证方式')).value).toBe('mfa')
    } finally {
      restore()
    }
  })
})

describe('NewConnectionDialog test connection', () => {
  /** 完整 internals stub:invoke 路由 + transformCallback 收集事件回调(按注册序)。 */
  function stubFullInternals(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
    const w = window as unknown as {
      __TAURI_INTERNALS__?: { invoke: unknown; transformCallback: (cb: unknown, once?: boolean) => number }
    }
    const prev = w.__TAURI_INTERNALS__
    const callbacks: Array<(envelope: { event: string; id: number; payload: unknown }) => void> = []
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'plugin:event|listen') return Promise.resolve(callbacks.length)
        if (cmd === 'plugin:event|unlisten') return Promise.resolve(null)
        const handler = handlers[cmd]
        if (handler === undefined) return Promise.reject(new Error(`unexpected command: ${cmd}`))
        return Promise.resolve(handler(args))
      },
      transformCallback: (cb: unknown) => {
        callbacks.push(cb as (typeof callbacks)[number])
        return callbacks.length - 1
      },
    }
    return {
      restore: () => {
        if (prev === undefined) delete w.__TAURI_INTERNALS__
        else w.__TAURI_INTERNALS__ = prev
      },
      /** 触发第 index 个注册回调(kb=0,hostkey=1)。 */
      emit: (index: number, payload: unknown) => {
        callbacks[index]?.({ event: 'e', id: index, payload })
      },
    }
  }

  /** 手动控制 resolve 的 Promise(观察「测试中…」瞬态用)。 */
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => { resolve = res })
    return { promise, resolve }
  }

  it('tests an ssh password connection and shows success with elapsed time', async () => {
    const test = vi.fn((..._args: unknown[]) => ({ ok: true, message: 'OK', elapsed_ms: 12 }))
    const restore = stubTauriInternals({ test_ssh_connection: args => test(args) })
    try {
      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      // 缺主机/用户名 → 测试连接禁用
      expect(screen.getByText('测试连接').hasAttribute('disabled')).toBe(true)
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'h' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'u' } })
      fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw' } })
      fireEvent.click(screen.getByText('测试连接'))
      expect(await screen.findByText('OK (12ms)')).toBeTruthy()
      const args = test.mock.calls[0]![0] as { config: Record<string, unknown>; testSessionId: string }
      expect(args.config).toMatchObject({
        host: 'h', port: 22, username: 'u', auth: { Password: 'pw' },
      })
      expect(args.testSessionId).toMatch(/^test-\d+$/)
    } finally {
      restore()
    }
  })

  it('shows the backend failure reason and the default fail message', async () => {
    const restore = stubTauriInternals({
      test_ssh_connection: () => ({ ok: false }),
    })
    try {
      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'h' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'u' } })
      fireEvent.click(screen.getByText('测试连接'))
      expect(await screen.findByText('连接失败')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('shows the thrown error when the test command rejects', async () => {
    let calls = 0
    const restore = stubTauriInternals({
      test_ssh_connection: () => {
        calls += 1
        if (calls === 1) throw 'raw reject'
        throw new Error('ipc down')
      },
    })
    try {
      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'h' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'u' } })
      fireEvent.click(screen.getByText('测试连接'))
      // 非 Error 抛出走 String(e) 分支
      expect(await screen.findByText('raw reject')).toBeTruthy()
      fireEvent.click(screen.getByText('测试连接'))
      expect(await screen.findByText('ipc down')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('blocks ssh edit-mode tests with blank secrets (password / mfa / key)', async () => {
    const test = vi.fn((..._args: unknown[]) => ({ ok: true }))
    const restore = stubTauriInternals({ test_ssh_connection: args => test(args) })
    try {
      render(<NewConnectionDialog
        asset={makeAsset({ config: { host: 'h', username: 'u' } })}
        onClose={() => {}}
        onSaved={() => {}}
      />)
      fireEvent.click(screen.getByText('测试连接'))
      expect(await screen.findByText(/测试前请输入密码/)).toBeTruthy()
      cleanup()
      render(<NewConnectionDialog
        asset={makeAsset({ config: { host: 'h', username: 'u', authMode: 'mfa' } })}
        onClose={() => {}}
        onSaved={() => {}}
      />)
      fireEvent.click(screen.getByText('测试连接'))
      expect(await screen.findByText(/测试前请输入 MFA 主密码/)).toBeTruthy()
      cleanup()
      render(<NewConnectionDialog
        asset={makeAsset({ config: { host: 'h', username: 'u', authMode: 'key' } })}
        onClose={() => {}}
        onSaved={() => {}}
      />)
      fireEvent.click(screen.getByText('测试连接'))
      expect(await screen.findByText(/测试前请选择私钥文件/)).toBeTruthy()
      expect(test).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('runs the edit-mode key test after a new key file is chosen (no passphrase)', async () => {
    const test = vi.fn((..._args: unknown[]) => ({ ok: true, message: 'OK' }))
    const restore = stubTauriInternals({ test_ssh_connection: args => test(args) })
    try {
      render(<NewConnectionDialog
        asset={makeAsset({ config: { host: 'h', username: 'u', authMode: 'key' } })}
        onClose={() => {}}
        onSaved={() => {}}
      />)
      const file = new File(['---K2---'], 'id_ed25519', { type: 'text/plain' })
      fireEvent.change(screen.getByLabelText('私钥文件'), { target: { files: [file] } })
      await screen.findByText('id_ed25519')
      fireEvent.click(screen.getByText('测试连接'))
      expect(await screen.findByText('OK')).toBeTruthy()
      const args = test.mock.calls[0]![0] as { config: { auth: { PrivateKey: { key: string; passphrase: string | null } } } }
      expect(args.config.auth.PrivateKey).toEqual({ key: '---K2---', passphrase: null })
    } finally {
      restore()
    }
  })

  it('sends kb_interactive with a null password when the mfa password is blank (create mode)', async () => {
    const test = vi.fn((..._args: unknown[]) => ({ ok: false, message: 'auth fail' }))
    const restore = stubTauriInternals({ test_ssh_connection: args => test(args) })
    try {
      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'mfa' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'h' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'u' } })
      fireEvent.click(screen.getByText('测试连接'))
      expect(await screen.findByText('auth fail')).toBeTruthy()
      const args = test.mock.calls[0]![0] as { config: Record<string, unknown> }
      expect(args.config.kb_interactive).toEqual({ enabled: true, password: null })
      expect(args.config.auth).toEqual({ Password: '' })
    } finally {
      restore()
    }
  })

  it('tests an ssh key connection with the selected private key', async () => {
    const test = vi.fn((..._args: unknown[]) => ({ ok: true, message: 'OK' }))
    const restore = stubTauriInternals({ test_ssh_connection: args => test(args) })
    try {
      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'key' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'h' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'u' } })
      // 未选私钥 → 测试连接禁用
      expect(screen.getByText('测试连接').hasAttribute('disabled')).toBe(true)
      const file = new File(['---KEY---'], 'id_rsa', { type: 'text/plain' })
      fireEvent.change(screen.getByLabelText('私钥文件'), { target: { files: [file] } })
      await screen.findByText('id_rsa')
      fireEvent.change(screen.getByLabelText('私钥口令(可空)'), { target: { value: 'pp' } })
      fireEvent.click(screen.getByText('测试连接'))
      expect(await screen.findByText('OK')).toBeTruthy()
      const args = test.mock.calls[0]![0] as { config: { auth: { PrivateKey: { key: string; passphrase: string } } } }
      expect(args.config.auth.PrivateKey).toEqual({ key: '---KEY---', passphrase: 'pp' })
    } finally {
      restore()
    }
  })

  it('drives the kb-interactive prompt and auto-accepts the hostkey during an mfa test', async () => {
    const pending = deferred<{ ok: boolean; message: string }>()
    const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = []
    const stub = stubFullInternals({
      test_ssh_connection: (args) => {
        calls.push({ cmd: 'test_ssh_connection', args })
        return pending.promise
      },
      ssh_hostkey_response: (args) => {
        calls.push({ cmd: 'ssh_hostkey_response', args })
        return null
      },
      ssh_kb_response: (args) => {
        calls.push({ cmd: 'ssh_kb_response', args })
        return null
      },
    })
    try {
      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'mfa' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'h' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'u' } })
      fireEvent.change(screen.getByLabelText(/MFA 主密码/), { target: { value: 'mpw' } })
      fireEvent.click(screen.getByText('测试连接'))
      // 等待两次事件订阅完成(kb + hostkey)并发出测试请求
      await vi.waitFor(() =>{  expect(calls.some(c => c.cmd === 'test_ssh_connection')).toBe(true) })
      // 测试中瞬态:按钮与状态行都显示进行中
      expect(screen.getAllByText('测试中…').length).toBeGreaterThan(0)
      // hostkey 确认 → 自动接受(不持久化)
      act(() => { stub.emit(1, { hostname: 'h', port: 22 }) })
      await vi.waitFor(() =>{  expect(calls.some(c => c.cmd === 'ssh_hostkey_response')).toBe(true) })
      expect(calls.find(c => c.cmd === 'ssh_hostkey_response')?.args)
        .toEqual({ id: calls[0]!.args!.testSessionId, allowed: true, persist: false })
      // kb 事件:空 instructions 不渲染说明行,空 prompt 回退「验证码」
      act(() => {
        stub.emit(0, {
          instructions: '',
          prompts: [{ prompt: '', echo: false }, { prompt: 'Token:', echo: true }],
          autoFill: [null, '123'],
        })
      })
      const fallback = await screen.findByLabelText<HTMLInputElement>('验证码')
      expect(fallback.type).toBe('password')
      expect((screen.getByLabelText<HTMLInputElement>('Token:')).value).toBe('123')
      expect(screen.queryByText('提交验证码')).toBeTruthy()
      fireEvent.change(fallback, { target: { value: '456' } })
      // 再推一条带 instructions 且 autoFill 短于 prompts 的事件,覆盖说明行渲染与答案回退
      act(() => {
        stub.emit(0, {
          instructions: '请输入验证码',
          prompts: [{ prompt: 'OTP:', echo: false }],
          autoFill: [],
        })
      })
      expect(await screen.findByText('请输入验证码')).toBeTruthy()
      fireEvent.change(screen.getByLabelText('OTP:'), { target: { value: '789' } })
      fireEvent.click(screen.getByText('提交验证码'))
      await vi.waitFor(() =>{  expect(calls.some(c => c.cmd === 'ssh_kb_response')).toBe(true) })
      expect(calls.find(c => c.cmd === 'ssh_kb_response')?.args)
        .toEqual({ id: calls[0]!.args!.testSessionId, responses: ['789'] })
      // 测试连接 config 含 kb_interactive 契约
      expect((calls[0]!.args!.config as Record<string, unknown>).kb_interactive)
        .toEqual({ enabled: true, password: 'mpw' })
      await act(async () => {
        pending.resolve({ ok: true, message: 'OK' })
        await pending.promise
      })
      expect(await screen.findByText('OK')).toBeTruthy()
      // 结束后 kb 面板关闭
      expect(screen.queryByText('提交验证码')).toBeNull()
    } finally {
      stub.restore()
    }
  })

  it('tests mysql / postgres / redis / elasticsearch with per-type commands', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = []
    const restore = stubTauriInternals({
      // mysql 不带 message → 缺省「连接成功」文案
      db_mysql_test: (args) => { calls.push({ cmd: 'db_mysql_test', args: args as Record<string, unknown> | undefined }); return { ok: true } },
      db_postgres_test: (args) => { calls.push({ cmd: 'db_postgres_test', args: args as Record<string, unknown> | undefined }); return { ok: true, message: 'OK' } },
      db_redis_test: (args) => { calls.push({ cmd: 'db_redis_test', args: args as Record<string, unknown> | undefined }); return { ok: true, message: 'OK' } },
      db_es_test: (args) => { calls.push({ cmd: 'db_es_test', args: args as Record<string, unknown> | undefined }); return { ok: true, message: 'OK' } },
    })
    try {
      const view = render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'mysql' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'db' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'root' } })
      fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw' } })
      fireEvent.change(screen.getByLabelText('数据库(可空)'), { target: { value: 'shop' } })
      fireEvent.click(screen.getByText('测试连接'))
      await screen.findByText('连接成功')
      expect(calls[0]).toEqual({
        cmd: 'db_mysql_test',
        args: { params: { host: 'db', port: 3306, password: 'pw', username: 'root', database: 'shop', ssl: false } },
      })
      view.unmount()

      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'postgresql' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'pg' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'postgres' } })
      fireEvent.click(screen.getByText('测试连接'))
      await screen.findByText('OK')
      expect(calls[1]!.cmd).toBe('db_postgres_test')
      cleanup()

      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'redis' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'r' } })
      // DB 索引清空回退 0,再改成 3
      fireEvent.change(screen.getByLabelText('DB 索引'), { target: { value: '' } })
      fireEvent.change(screen.getByLabelText('DB 索引'), { target: { value: '3' } })
      fireEvent.click(screen.getByText('测试连接'))
      await screen.findByText('OK')
      expect(calls[2]!.args).toEqual({ params: { host: 'r', port: 6379, password: '', db: 3, ssl: false } })
      cleanup()

      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'elasticsearch' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'es' } })
      fireEvent.click(screen.getByLabelText(/使用 SSL/))
      fireEvent.click(screen.getByText('测试连接'))
      await screen.findByText('OK')
      expect(calls[3]).toEqual({
        cmd: 'db_es_test',
        args: { params: { host: 'es', port: 9200, password: '', username: '', useSSL: true } },
      })
    } finally {
      restore()
    }
  })

  it('tests kafka / nsq through broker_test and docker through docker_test', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = []
    const restore = stubTauriInternals({
      broker_test: (args) => { calls.push({ cmd: 'broker_test', args: args as Record<string, unknown> | undefined }); return { ok: true, message: 'OK' } },
      docker_test: (args) => { calls.push({ cmd: 'docker_test', args: args as Record<string, unknown> | undefined }); return { ok: true, message: 'OK' } },
    })
    try {
      const view = render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'kafka' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'k' } })
      fireEvent.click(screen.getByText('测试连接'))
      await screen.findByText('OK')
      expect(calls[0]).toEqual({
        cmd: 'broker_test',
        args: { kind: 'kafka', params: { host: 'k', port: 9092, username: '', password: '', ssl: false } },
      })
      view.unmount()

      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'nsq' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'n' } })
      fireEvent.click(screen.getByText('测试连接'))
      await screen.findByText('OK')
      expect(calls[1]!.args).toMatchObject({ kind: 'nsq' })
      cleanup()

      // docker socket:地址留空 → 缺省 socket 路径
      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'docker' } })
      // 显式来回切换连接方式(socket 分支)
      fireEvent.change(screen.getByLabelText('连接方式'), { target: { value: 'tcp' } })
      fireEvent.change(screen.getByLabelText('连接方式'), { target: { value: 'socket' } })
      fireEvent.click(screen.getByText('测试连接'))
      await screen.findByText('OK')
      expect(calls[2]).toEqual({
        cmd: 'docker_test',
        args: { params: { transport: 'socket', socketPath: '/var/run/docker.sock', host: undefined } },
      })
      cleanup()

      // docker tcp:地址进 host;先回 socket 自定义路径再切 tcp,覆盖两条分支
      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'docker' } })
      fireEvent.change(screen.getByLabelText('Socket 路径'), { target: { value: '/run/custom.sock' } })
      fireEvent.click(screen.getByText('测试连接'))
      await screen.findByText('OK')
      expect(calls[3]!.args).toEqual({
        params: { transport: 'socket', socketPath: '/run/custom.sock', host: undefined },
      })
      fireEvent.change(screen.getByLabelText('连接方式'), { target: { value: 'tcp' } })
      fireEvent.change(screen.getByLabelText('地址 *'), { target: { value: 'tcp://10.0.0.9:2375' } })
      fireEvent.click(screen.getByText('测试连接'))
      await screen.findByText('OK')
      expect(calls[4]!.args).toEqual({
        params: { transport: 'tcp', socketPath: undefined, host: 'tcp://10.0.0.9:2375' },
      })
    } finally {
      restore()
    }
  })
})

describe('NewConnectionDialog elasticsearch address', () => {
  it('creates an ES asset with a single Address URL and sends it to db_es_test', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const esTest = vi.fn((_args?: unknown) => ({ ok: true, message: 'OK' }))
    const restore = stubTauriInternals({
      create_asset: args => create(args),
      db_es_test: args => esTest(args),
    })
    try {
      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'elasticsearch' } })
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'es1' } })
      fireEvent.change(screen.getByLabelText('端点方式'), { target: { value: 'address' } })
      fireEvent.change(screen.getByLabelText('地址 *'), { target: { value: 'http://10.0.0.9:9200' } })
      fireEvent.click(screen.getByText('测试连接'))
      await screen.findByText('OK')
      expect(esTest).toHaveBeenCalledWith({
        params: { host: '', port: 9200, password: '', username: '', useSSL: false, address: 'http://10.0.0.9:9200' },
      })
      fireEvent.click(screen.getByText('创建'))
      expect(create).toHaveBeenCalledWith({
        params: {
          type: 'db', name: 'es1', group_id: null, tags: [],
          config: {
            dbType: 'elasticsearch', host: '', port: 9200, username: undefined, password: undefined,
            database: undefined, db: undefined, ssl: false, address: 'http://10.0.0.9:9200', addresses: undefined,
          },
        },
      })
    } finally {
      restore()
    }
  })

  it('creates an ES asset with Multi Nodes and echoes both nodes back on edit', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const esTest = vi.fn((_args?: unknown) => ({ ok: true, message: 'OK' }))
    const restore = stubTauriInternals({
      create_asset: args => create(args),
      db_es_test: args => esTest(args),
    })
    try {
      const view = render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'elasticsearch' } })
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'es2' } })
      fireEvent.change(screen.getByLabelText('端点方式'), { target: { value: 'multi' } })
      fireEvent.change(screen.getByLabelText('节点地址 *'), { target: { value: 'http://a:9200\nhttp://b:9200' } })
      fireEvent.click(screen.getByText('测试连接'))
      await screen.findByText('OK')
      expect(esTest).toHaveBeenCalledWith({
        params: { host: '', port: 9200, password: '', username: '', useSSL: false, addresses: ['http://a:9200', 'http://b:9200'] },
      })
      fireEvent.click(screen.getByText('创建'))
      const firstCall = create.mock.calls[0]
      const cfg = firstCall === undefined
        ? undefined
        : (firstCall[0] as { params: { config: Record<string, unknown> } }).params.config
      expect(cfg?.addresses).toEqual(['http://a:9200', 'http://b:9200'])
      view.unmount()
      cleanup()

      // 编辑回显 multi addresses(用户报告的「地址没回显」正是此路径)
      const editAsset = makeAsset({ type: 'db', name: 'es-edit', config: { dbType: 'elasticsearch', addresses: ['http://a:9200', 'http://b:9200'] } })
      render(<NewConnectionDialog asset={editAsset} onClose={() => {}} onSaved={() => {}} />)
      expect((screen.getByLabelText<HTMLSelectElement>('端点方式')).value).toBe('multi')
      expect((screen.getByLabelText<HTMLTextAreaElement>('节点地址 *')).value).toBe('http://a:9200\nhttp://b:9200')
    } finally {
      restore()
    }
  })

  it('echoes a single ES Address and a host-mode asset on mount', async () => {
    const restore = stubTauriInternals({})
    try {
      const single = makeAsset({ type: 'db', name: 'es-addr', config: { dbType: 'elasticsearch', address: 'http://x:9200' } })
      const view = render(<NewConnectionDialog asset={single} onClose={() => {}} onSaved={() => {}} />)
      expect((screen.getByLabelText<HTMLSelectElement>('端点方式')).value).toBe('address')
      expect((screen.getByLabelText<HTMLInputElement>('地址 *')).value).toBe('http://x:9200')
      view.unmount()
      cleanup()

      const hostAsset = makeAsset({ type: 'db', name: 'es-host', config: { dbType: 'elasticsearch', host: 'es-host', port: 9201 } })
      render(<NewConnectionDialog asset={hostAsset} onClose={() => {}} onSaved={() => {}} />)
      expect((screen.getByLabelText<HTMLSelectElement>('端点方式')).value).toBe('host')
      expect((screen.getByLabelText<HTMLInputElement>('主机 *')).value).toBe('es-host')
      // host 模式下的端口输入(独立 onChange 分支)+ 空值回退缺省端口
      fireEvent.change(screen.getByLabelText('端口'), { target: { value: '9222' } })
      expect((screen.getByLabelText<HTMLInputElement>('端口')).value).toBe('9222')
      fireEvent.change(screen.getByLabelText('端口'), { target: { value: '' } })
      expect((screen.getByLabelText<HTMLInputElement>('端口')).value).toBe('9200')
    } finally {
      restore()
    }
  })

  it('requires an ES address or node before create in address and multi modes', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: args => create(args) })
    try {
      render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'elasticsearch' } })
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'es' } })
      // address 模式空/全空白 → 创建禁用
      fireEvent.change(screen.getByLabelText('端点方式'), { target: { value: 'address' } })
      expect(screen.getByText('创建').hasAttribute('disabled')).toBe(true)
      fireEvent.change(screen.getByLabelText('地址 *'), { target: { value: ' ' } })
      expect(screen.getByText('创建').hasAttribute('disabled')).toBe(true)
      // multi 模式空节点 → 禁用;填一个 → 启用
      fireEvent.change(screen.getByLabelText('端点方式'), { target: { value: 'multi' } })
      expect(screen.getByText('创建').hasAttribute('disabled')).toBe(true)
      fireEvent.change(screen.getByLabelText('节点地址 *'), { target: { value: 'http://a:9200\n' } })
      expect(screen.getByText('创建').hasAttribute('disabled')).toBe(false)
      // 切回 host 模式(端点方式 select 的 host 分支)
      fireEvent.change(screen.getByLabelText('端点方式'), { target: { value: 'host' } })
      expect((screen.getByLabelText<HTMLInputElement>('主机 *')).value).toBe('')
      expect(create).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})
