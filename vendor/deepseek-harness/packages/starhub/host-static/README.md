# @deepseek-ai/dsh-starhub-host-static

StarHub-local host plugin (not upstream). Registers the `/starhub-react` prefix route on the dsh `webServer` for the standalone React workbench window app (`npm run build:window` → repo `dist-starhub-react/`, vite base `/starhub-react/`). Independent windows opened for Tools instance clicks load this entry and reuse the client-nav React workbenches full-window.

The plugin resolves the dist in this order: the `windowDist` Config field, `STARHUB_WINDOW_DIST`, then repo `dist-starhub-react` (the repo root is found by walking up to the directory containing `vendor/deepseek-harness`). Its `index.html` must reference `/starhub-react`-prefixed assets; a wrong base fails loud on the Config/env tier and is skipped on the repo tier. A missing build fails plugin startup.

The `windowDist` Config field exists for the installed shell: the M4 provisioning script (`scripts/provision-dsh.mjs` in the StarHub repo) installs the workbench dist under `$DSH_HOME/starhub/resources/starhub-react` and writes that absolute path into the profile patch, so an installed shell never depends on a StarHub checkout being present.

## Model Experience

### Static workbench hosting

#### What the model sees

Nothing — the plugin only serves the `/starhub-react` web build over the dsh `webServer`; it registers no prompt, tool, or message surface.

#### Token effect

None — no model-request participation.

#### KV Cache effect

Not applicable.

## Known Limitations and Deferred Work

- Asset MIME coverage is the minimal set the StarHub build emits (html/js/css/svg/png/woff2/json/map); other extensions ship as `application/octet-stream`.
- HEAD responses currently write the body like GET (mirrors `frontend-static`).
