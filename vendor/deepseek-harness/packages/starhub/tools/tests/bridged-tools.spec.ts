/**
 * 桥接工具清单的机械校验(tools 包首个 spec)。
 *
 * 三张表描述同一批工具:Rust `src-tauri/src/browser/mod.rs` 的 BROWSER_TOOLS、
 * 本文件的 BRIDGED_TOOLS、approval-bridge 的 STARHUB_DOMAIN_TOOLS。它们此前
 * 只靠注释互引,没有任何机械校验——漏登记任何一张表的后果分别是「分发 404」
 * 或「风险门返回 null = 完全不确认」(见 risk-gate.spec.ts)。本文件把 vendor
 * 侧名单钉成断言:Rust 侧有 browser_tools_table_covers_every_parseable_name
 * 自校验,加/减工具时两侧测试会同时变红,逼使同步。
 *
 * 注意:browser_* 名单与 Rust BROWSER_TOOLS 的一致性靠双方 pin 保证,不是
 * 跨语言读取;将来若要做真对拍,在 CI 加一个读 Rust 常量的脚本即可。
 */
import { describe, expect, it } from 'vitest'
import { BRIDGED_TOOLS } from '../src/index.ts'

/** 与 Rust src-tauri/src/browser/mod.rs BROWSER_TOOLS 逐项对齐。 */
const RUST_BROWSER_TOOLS = [
  'browser_open',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_state',
  'browser_extract',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_select_option',
  'browser_scroll',
  'browser_screenshot',
  'browser_eval',
  'browser_decide',
  'browser_auto',
]

const browserSpecs = () => BRIDGED_TOOLS.filter(spec => spec.toolName.startsWith('browser_'))

describe('BRIDGED_TOOLS registry', () => {
  it('has no duplicate tool names (dsh registration would silently collide)', () => {
    const names = BRIDGED_TOOLS.map(spec => spec.toolName)
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
    expect(duplicates).toEqual([])
  })

  it('pins the browser_* tool list to Rust BROWSER_TOOLS', () => {
    expect(browserSpecs().map(spec => spec.toolName)).toEqual(RUST_BROWSER_TOOLS)
  })

  it('keeps every spec model-usable: non-empty description and parameters object', () => {
    for (const spec of BRIDGED_TOOLS) {
      expect(spec.description.length, spec.toolName).toBeGreaterThan(0)
      expect(typeof spec.parameters, spec.toolName).toBe('object')
    }
  })

  it('describes browser_decide as read-only decision with goal/snapshot params', () => {
    const decide = BRIDGED_TOOLS.find(spec => spec.toolName === 'browser_decide')
    expect(decide).toBeDefined()
    expect(decide?.description).toContain('不执行')
    expect(decide?.description).toContain('必须先调用本工具')
    expect(decide?.parameters).toMatchObject({
      goal: { type: 'string', required: true },
      snapshot: { type: 'string' },
    })
  })
})
