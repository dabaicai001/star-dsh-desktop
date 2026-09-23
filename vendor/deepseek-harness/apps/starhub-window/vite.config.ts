import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

/**
 * Standalone StarHub workbench window build.
 *
 * The dsh shell origin already serves the client-nav bundle that owns the
 * workbench components; this tiny app is a browser mount that reuses those
 * components by importing them straight from client-nav source and rendering
 * the requested workbench full-window. It must NOT be served by bare Vite (it
 * is only meaningful under the dsh origin where Tauri IPC is injected), so
 * `vite preview`/`vite dev` are rejected; the built dist is served by
 * starhub-host-static at `/starhub-react` and loaded in a fresh webview window.
 *
 * Workspace packages are aliased to SOURCE so CSS rides Vite's pipeline (the
 * lib bundles externalize CSS) — mirroring apps/web. Only the packages the
 * workbenches actually reach are aliased. This file's alias list is a manual
 * closure of that reach: linux-compat CI runs `build:window` on a CLEAN
 * checkout (no lib/ artifacts anywhere), so any workspace package that becomes
 * value-reached through an aliased package's source must be added here —
 * otherwise resolution falls through to node_modules → `main: lib/index.js`
 * → vite "Failed to resolve entry for package" (v0.122.0: DSH 0.1.7's new
 * `dsh-util-workspace-path` reached through ui-primitives/PathLabel).
 */
export default defineConfig({
  plugins: [
    {
      name: 'starhub-window-reject-standalone-serve',
      config(_config, env) {
        if (env.command === 'serve') {
          throw new Error('starhub-window is served by dsh via /starhub-react; run `vite build` instead of a dev/preview server')
        }
      },
    },
    react(),
  ],
  build: {
    sourcemap: true,
    outDir: 'dist',
  },
  base: '/starhub-react/',
  resolve: {
    alias: [
      { find: /^@deepseek-ai\/dsh-client-ui-theme\/styles\//, replacement: `${src('../../packages/client/ui-theme/src/styles')}/` },
      { find: /^@deepseek-ai\/dsh-client-web-react$/, replacement: src('../../packages/client/web-react/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-slots$/, replacement: src('../../packages/client/ui-slots/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: src('../../packages/client/ui-primitives/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-runtime$/, replacement: src('../../packages/client/runtime/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-layout$/, replacement: src('../../packages/client/ui-layout/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-sidebar$/, replacement: src('../../packages/client/ui-sidebar/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-util-workspace-path$/, replacement: src('../../packages/util/workspace-path/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-store$/, replacement: src('../../packages/client/store/src/index.ts') },
    ],
  },
})
