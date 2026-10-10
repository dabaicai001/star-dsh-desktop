// @vitest-environment jsdom
/**
 * 侧栏「StarHub 工具」入口图标(v0.133.0):换成品牌字形(四角星 + 中心节点),
 * 尺寸由侧栏下发、颜色靠 `currentColor` 跟随选中态。
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ToolsPanelIcon } from '../src/client/ToolsPanelIcon.tsx'

describe('ToolsPanelIcon', () => {
  it('renders the StarHub star + hub glyph at the size the sidebar asks for', () => {
    const { container } = render(<ToolsPanelIcon size={18} active={false} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('width')).toBe('18')
    expect(svg?.getAttribute('height')).toBe('18')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 16 16')
    // 品牌字形:一个四角星路径 + 一个中心节点圆(星与 hub)
    const star = container.querySelector('path')
    expect(star?.getAttribute('stroke')).toBe('currentColor')
    const hub = container.querySelector('circle')
    expect(hub?.getAttribute('fill')).toBe('currentColor')
    expect(hub?.getAttribute('cx')).toBe('8')
  })

  it('follows the requested edge when the sidebar switches its rail size', () => {
    const { container } = render(<ToolsPanelIcon size={16} active />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('16')
  })
})
