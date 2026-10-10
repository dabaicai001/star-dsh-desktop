/**
 * 桥接工具清单的机械校验(tools 包首个 spec)。
 *
 * 三张表描述同一批工具:Rust 侧各域方法面、本文件的 BRIDGED_TOOLS、
 * approval-bridge 的 STARHUB_DOMAIN_TOOLS。它们此前只靠注释互引,没有任何机械
 * 校验——漏登记任何一张表的后果分别是「分发 404」或「风险门返回 null = 完全
 * 不确认」(见 risk-gate.spec.ts)。
 *
 * M4 定稿:AI 浏览器(`browser_*` 16 工具)整体删除——上游 dsh 原生提供
 * browser-use,StarHub 重复造一份只会双轨维护。因此这里新增一条**反向断言**:
 * 任何 `browser_` 前缀的工具都不许再回到 BRIDGED_TOOLS(回归即红)。
 */
import { describe, expect, it } from 'vitest'
import { BRIDGED_TOOLS } from '../src/index.ts'

describe('BRIDGED_TOOLS registry', () => {
  it('has no duplicate tool names (dsh registration would silently collide)', () => {
    const names = BRIDGED_TOOLS.map(spec => spec.toolName)
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
    expect(duplicates).toEqual([])
  })

  it('carries no browser_* tool (AI 浏览器已整体删除,归上游 dsh browser-use)', () => {
    const browserTools = BRIDGED_TOOLS
      .map(spec => spec.toolName)
      .filter(name => name.startsWith('browser_'))
    expect(browserTools).toEqual([])
  })

  it('carries no desktop_* tool (AI 沙箱桌面已整体删除)', () => {
    const desktopTools = BRIDGED_TOOLS
      .map(spec => spec.toolName)
      .filter(name => name.startsWith('desktop_'))
    expect(desktopTools).toEqual([])
  })

  it('keeps every spec model-usable: non-empty description and parameters object', () => {
    for (const spec of BRIDGED_TOOLS) {
      expect(spec.description.length, spec.toolName).toBeGreaterThan(0)
      expect(typeof spec.parameters, spec.toolName).toBe('object')
    }
  })
})
