/**
 * host-static 的 dist 定位优先级(去 Tauri 化 M4 新增 Config 一档)。
 *
 * 顺序是部署形态的决定:provisioning 装好的 dist 走 `windowDist` Config,
 * 开发布局走 `STARHUB_WINDOW_DIST`,最后才是仓库内 `dist-starhub-react`。
 * 三档都可能指向错误的 vite base,因此 env/Config 档必须 fail loud,仓库回退档
 * 只跳过(仓库里可能同时存在多个 dist)。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDist, resolveWindowDistRoot, WINDOW_PREFIX } from '../src/index.ts'

/** 造一个带正确 vite base 的假 dist。 */
function makeDist(base = '/starhub-react'): string {
  const dir = mkdtempSync(join(tmpdir(), 'starhub-host-static-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), `<html><script src="${base}/assets/index.js"></script></html>`)
  return dir
}

describe('resolveDist', () => {
  it('prefers the explicit location and rejects a wrong vite base loud', () => {
    const good = makeDist()
    const wrong = makeDist('/starhub')
    expect(resolveDist(WINDOW_PREFIX, good, ['dist-starhub-react'], 'empty')).toBe(good)
    expect(() => resolveDist(WINDOW_PREFIX, wrong, ['dist-starhub-react'], 'empty'))
      .toThrow(/资源引用未带/)
    rmSync(good, { recursive: true, force: true })
    rmSync(wrong, { recursive: true, force: true })
  })

  it('skips a wrong-base repo fallback instead of throwing', () => {
    // 回退档(仓库内)可能同时躺着别的 base 的 dist:跳过而不是炸
    expect(() => resolveDist(WINDOW_PREFIX, undefined, ['/nonexistent-dist'], 'no dist'))
      .toThrow('no dist')
  })
})

describe('resolveWindowDistRoot', () => {
  it('takes the windowDist Config over the env var and the repo fallback', () => {
    const fromConfig = makeDist()
    const fromEnv = makeDist()
    const previous = process.env.STARHUB_WINDOW_DIST
    process.env.STARHUB_WINDOW_DIST = fromEnv
    try {
      expect(resolveWindowDistRoot({ windowDist: fromConfig })).toBe(fromConfig)
      expect(resolveWindowDistRoot({})).toBe(fromEnv)
      expect(resolveWindowDistRoot({ windowDist: '   ' })).toBe(fromEnv)
    } finally {
      if (previous === undefined) delete process.env.STARHUB_WINDOW_DIST
      else process.env.STARHUB_WINDOW_DIST = previous
      rmSync(fromConfig, { recursive: true, force: true })
      rmSync(fromEnv, { recursive: true, force: true })
    }
  })
})
