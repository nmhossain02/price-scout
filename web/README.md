# Price Scout web console

The React operator console for creating monitors, reviewing compiled or repaired plans, inspecting browser evidence, and watching control-plane health.

```bash
npm install
npm run dev
```

Vite proxies API requests to `http://127.0.0.1:8080`. Override the browser-visible origin with `VITE_API_BASE_URL` when the UI and API are served separately.

```bash
npm test
npm run build
```

The production image serves the SPA on port 3000 and proxies API, health, metrics, and SSE traffic to the Compose service named `api`.
