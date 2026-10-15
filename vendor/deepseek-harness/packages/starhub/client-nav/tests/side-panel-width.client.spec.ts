// @vitest-environment jsdom
/**
 * 侧栏宽度持久化(side-panel-width.ts):localStorage 加载 / 保存 / 夹取
 * (340–560px),含缺失、畸形 JSON、非数字、越界值与非有限值路径。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampSidePanelWidth, loadSidePanelWidth, saveSidePanelWidth,
  SIDE_PANEL_DEFAULT_WIDTH, SIDE_PANEL_MAX_WIDTH, SIDE_PANEL_MIN_WIDTH,
} from '../src/client/terminal/side-panel-width.ts'

const STORAGE_KEY = 'starhub:ssh:side-panel-width'

beforeEach(() => {
  localStorage.clear()
})

describe('clampSidePanelWidth', () => {
  it('keeps in-range values (rounded)', () => {
    expect(clampSidePanelWidth(460)).toBe(460)
    expect(clampSidePanelWidth(460.4)).toBe(460)
  })

  it('clamps to the min / max bounds', () => {
    expect(clampSidePanelWidth(100)).toBe(SIDE_PANEL_MIN_WIDTH)
    expect(clampSidePanelWidth(9999)).toBe(SIDE_PANEL_MAX_WIDTH)
    expect(clampSidePanelWidth(SIDE_PANEL_MIN_WIDTH - 1)).toBe(SIDE_PANEL_MIN_WIDTH)
    expect(clampSidePanelWidth(SIDE_PANEL_MAX_WIDTH + 1)).toBe(SIDE_PANEL_MAX_WIDTH)
  })

  it('falls back to the default for non-finite values', () => {
    expect(clampSidePanelWidth(Number.NaN)).toBe(SIDE_PANEL_DEFAULT_WIDTH)
    expect(clampSidePanelWidth(Number.POSITIVE_INFINITY)).toBe(SIDE_PANEL_DEFAULT_WIDTH)
  })
})

describe('loadSidePanelWidth', () => {
  it('returns the default when nothing is stored', () => {
    expect(loadSidePanelWidth()).toBe(SIDE_PANEL_DEFAULT_WIDTH)
  })

  it('returns the stored value', () => {
    localStorage.setItem(STORAGE_KEY, '460')
    expect(loadSidePanelWidth()).toBe(460)
  })

  it('clamps out-of-range stored values', () => {
    localStorage.setItem(STORAGE_KEY, '100')
    expect(loadSidePanelWidth()).toBe(SIDE_PANEL_MIN_WIDTH)
    localStorage.setItem(STORAGE_KEY, '9999')
    expect(loadSidePanelWidth()).toBe(SIDE_PANEL_MAX_WIDTH)
  })

  it('falls back to the default for malformed or non-number payloads', () => {
    localStorage.setItem(STORAGE_KEY, 'not json')
    expect(loadSidePanelWidth()).toBe(SIDE_PANEL_DEFAULT_WIDTH)
    localStorage.setItem(STORAGE_KEY, '"460"')
    expect(loadSidePanelWidth()).toBe(SIDE_PANEL_DEFAULT_WIDTH)
    localStorage.setItem(STORAGE_KEY, 'null')
    expect(loadSidePanelWidth()).toBe(SIDE_PANEL_DEFAULT_WIDTH)
    localStorage.setItem(STORAGE_KEY, '[460]')
    expect(loadSidePanelWidth()).toBe(SIDE_PANEL_DEFAULT_WIDTH)
  })
})

describe('saveSidePanelWidth', () => {
  it('writes the width as JSON', () => {
    saveSidePanelWidth(460)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('460')
  })

  it('clamps before writing', () => {
    saveSidePanelWidth(9999)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(SIDE_PANEL_MAX_WIDTH))
  })

  it('round-trips through load', () => {
    saveSidePanelWidth(520)
    expect(loadSidePanelWidth()).toBe(520)
  })
})
