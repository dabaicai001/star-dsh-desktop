import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { registerStatusTool } from '../src/index.ts'

/** Minimal registrant context capturing the registered tool definition. */
interface RegisteredTool {
  name: string
  execute: (args: never, exec: never) => Promise<unknown>
}

function fakeContext(): { ctx: Context; getRegistered: () => RegisteredTool | undefined } {
  let registered: RegisteredTool | undefined
  const ctx = {
    tools: {
      register: (definition: RegisteredTool) => {
        registered = definition
      },
    },
  } as unknown as Context
  return { ctx, getRegistered: () => registered }
}

/** A loopback transport pair speaking the sidecar side of the protocol. */
function transportPair(): { tool: JsonRpcLineTransport; dispose: () => void } {
  const toolToSidecar = new PassThrough()
  const sidecarToTool = new PassThrough()
  const tool = new JsonRpcLineTransport(sidecarToTool, toolToSidecar)
  const sidecar = new JsonRpcLineTransport(toolToSidecar, sidecarToTool)
  sidecar.onRequest(async (method) => {
    if (method === 'ping') return { pong: true, protocol: 'fake-sidecar/1.0.0' }
    if (method === 'starhub/capabilities') {
      return { protocol: 'fake-sidecar/1.0.0', methods: ['ping', 'starhub/capabilities'] }
    }
    throw new Error(`method not found: ${method}`)
  })
  sidecar.start()
  tool.start()
  return {
    tool,
    dispose: () => {
      tool.close()
      sidecar.close()
    },
  }
}

describe('starhub_sidecar_status tool', () => {
  it('reports liveness and the live method inventory as model-readable text', async () => {
    const { ctx, getRegistered } = fakeContext()
    const pair = transportPair()
    try {
      registerStatusTool(ctx, () => pair.tool)
      expect(getRegistered()?.name).toBe('starhub_sidecar_status')
      const output = (await getRegistered()!.execute({} as never, {} as never)) as { text: string }
      expect(output.text).toContain('alive')
      expect(output.text).toContain('fake-sidecar/1.0.0')
      expect(output.text).toContain('2 method(s) registered')
      expect(output.text).toContain('ping, starhub/capabilities')
    } finally {
      pair.dispose()
    }
  })

  it('propagates a transport failure as a tool failure', async () => {
    const { ctx, getRegistered } = fakeContext()
    const pair = transportPair()
    try {
      registerStatusTool(ctx, () => pair.tool)
      // The request is in flight when the transport closes: pending requests
      // reject with the closed-transport error, which the tool surfaces.
      const pending = getRegistered()!.execute({} as never, {} as never)
      pair.dispose()
      await expect(pending).rejects.toThrow()
    } finally {
      pair.dispose()
    }
  })
})
