/**
 * StarHub tool-context: pure rendering of the injected tool-context text.
 */
import { describe, expect, it } from 'vitest'
import { renderToolContext } from '../src/index.ts'

describe('renderToolContext', () => {
  it('returns null when neither tool nor asset is set', () => {
    expect(renderToolContext({})).toBeNull()
    expect(renderToolContext({ subcategory: '' })).toBeNull()
    expect(renderToolContext({ assetName: '' })).toBeNull()
  })

  it('renders tool and asset with route when both present', () => {
    const text = renderToolContext({
      subcategory: 'terminal',
      assetId: 'a1',
      assetName: 'prod-server',
      routePrefix: '/ssh',
    })
    expect(text).toContain('Tool: terminal')
    expect(text).toContain('Asset: prod-server')
    expect(text).toContain('Route: /ssh')
  })

  it('omits the route line when routePrefix is absent', () => {
    const text = renderToolContext({ subcategory: 'docker', assetName: 'docker-1' })
    expect(text).toContain('Tool: docker')
    expect(text).not.toContain('Route:')
  })

  it('appends the Docker delete guard hard rule for docker subcategory', () => {
    const text = renderToolContext({ subcategory: 'docker', assetName: 'docker-1', routePrefix: '/docker' })
    expect(text).toContain('Docker delete guard (hard rule)')
    expect(text).toContain('rm/rmi/prune')
    expect(text).toContain('explicit confirmation')
    // 非 docker 子类不携带该规则
    const terminal = renderToolContext({ subcategory: 'terminal', assetName: 's1' })
    expect(terminal).not.toContain('Docker delete guard')
  })

  it('carries the asset type and a tool-family guidance for db assets', () => {
    const text = renderToolContext({
      subcategory: 'database', assetId: 'a1', assetName: 'mydb', routePrefix: '/db/mysql', assetType: 'db', dbType: 'mysql',
    })
    expect(text).toContain('Asset type: database (mysql)')
    expect(text).toContain('Preferred tool: db_query')
    expect(text).toContain('NOT ssh_exec')
  })

  it('guides redis assets to redis_exec and es assets to es_*', () => {
    const redis = renderToolContext({ subcategory: 'database', assetName: 'r', assetType: 'db', dbType: 'redis' })
    expect(redis).toContain('Preferred tool: redis_exec')
    const es = renderToolContext({ subcategory: 'database', assetName: 'e', assetType: 'db', dbType: 'elasticsearch' })
    expect(es).toContain('Preferred tool: es_*')
  })

  it('omits the tool-family hint when assetType is absent', () => {
    const text = renderToolContext({ subcategory: 'terminal', assetName: 's1' })
    expect(text).not.toContain('Preferred tool')
  })

  it('falls back to the asset id when the display name is absent', () => {
    const text = renderToolContext({ subcategory: 'database', assetId: 'a9' })
    expect(text).toContain('Asset: a9')
  })
})
