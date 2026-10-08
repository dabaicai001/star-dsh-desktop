import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { spawnSidecar } from '../src/transport.ts'

const FAKE_SIDECAR = fileURLToPath(new URL('./fixtures/fake-sidecar.mjs', import.meta.url))

describe('sidecar transport', () => {
  it('spawns the sidecar, passes the health probe, and answers requests', async () => {
    const handle = await spawnSidecar([process.execPath, FAKE_SIDECAR], 5000)
    try {
      const result = await handle.transport.request('ping', {})
      expect(result).toEqual({ pong: true, protocol: 'fake-sidecar/1.0.0' })
    } finally {
      await handle.dispose()
    }
    expect(handle.child.exitCode !== null || handle.child.signalCode !== null).toBe(true)
  })

  it('maps an unknown method to the protocol error code', async () => {
    const handle = await spawnSidecar([process.execPath, FAKE_SIDECAR], 5000)
    try {
      await expect(handle.transport.request('nope', {})).rejects.toThrow(/method not found/)
    } finally {
      await handle.dispose()
    }
  })

  it('fails loud with a stderr tail when the health probe times out', async () => {
    await expect(spawnSidecar([process.execPath, FAKE_SIDECAR, '--fail-health'], 400)).rejects.toThrow(
      /health probe failed/,
    )
  })

  it('rejects an empty sidecar command', async () => {
    await expect(spawnSidecar([], 5000)).rejects.toThrow(/must name an executable/)
  })
})
