---
name: plugin-first-web-dashboard
description: "Build remote dashboards as plugins in MCP-first services."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [web-dashboard, plugins, MCP, Node.js, HTTP, SSE, remote-operations]
    related_skills: [claude-design, popular-web-designs, dogfood, requesting-code-review]
---

# Plugin-First Web Dashboard

Use when adding a web UI to a headless, MCP-first, plugin-oriented service—especially a service deployed remotely in Docker, NAS, or a router and expected to remain online without a local game/client process.

## Core approach

Treat the dashboard as a **Monitor / Operate** surface, not a marketing page. Start from the existing repository contracts, then build a small vertical slice that proves the data path before adding visual breadth.

1. Read the project README, agent/development rules, architecture docs, plugin API/loader docs, HTTP server, runtime context, storage API, and deployment manifest.
2. Trace the existing data sources and tool handlers to their definitions. Reuse established read-only services instead of duplicating SQL or authentication logic.
3. Keep concrete UI and dashboard routes in a plugin. Add only generic core infrastructure: route registration, authenticated dispatch, lifecycle cleanup, and narrowly scoped read-only service adapters.
4. Define an MVP around the always-on advantage: service health, authentication/WebSocket state, online friends, recent events, and plugin/backup status. Exclude local-client features such as launching VRChat, SteamVR detection, game logs, tray behavior, and desktop memory tools unless the deployment explicitly supports them.
5. Use a dark, dense, glanceable visual system with strong status hierarchy. Raycast/Linear-like precision is a useful reference, but transform the principles into an original UI rather than cloning a proprietary surface.
6. Verify the implementation with syntax checks, repository smoke tests, diff checks, and an actual authenticated endpoint probe when a running deployment is available. Report skipped checks honestly.

## Core/plugin boundary

The core should expose a minimal, explicit mechanism such as:

- `ctx.httpRoutes`: a route registry owned by the core;
- `api.http.registerRoute({ method, path, handler })`: plugin-only route registration;
- authenticated dispatch before route execution;
- route cleanup on unload and hot reload;
- read-only services such as `dashboard.snapshot`, `dashboard.friends`, and `dashboard.events`.

The plugin should:

- own `plugin.json`, its entry module, HTML/CSS/JS assets, and dashboard-specific handlers;
- consume named services through the plugin API;
- never import core internals, touch global context, open the database file, or read credentials/tokens;
- return a disposer when it owns timers, streams, watchers, or other handles;
- escape user/database strings before inserting them into HTML.

Do not make the plugin depend on MCP round-trips to the same process for every screen read unless that is an intentional contract. A read-only service adapter avoids serialization overhead while preserving the boundary.

## HTTP and authentication rules

- Run authentication before both built-in and plugin routes.
- Preserve the project's existing Bearer/API-key mechanism; do not create a second token format.
- Do not put a real token in source, HTML, docs examples, commits, logs, screenshots, or test fixtures.
- A browser address bar cannot attach an Authorization header. If query-token bootstrap is supported for a trusted LAN, keep it short-lived/session-scoped where possible, never advertise it as a public deployment pattern, and document the reverse-proxy alternative.
- Do not expose destructive operations in the first monitoring MVP. If later added, route them through existing safe-mode/confirmation semantics.
- Validate and clamp pagination limits server-side.
- Use `Cache-Control: no-store` for operational JSON and avoid caching sensitive state.

## Data and real-time behavior

Start with polling if it makes the vertical slice reliable; use a short refresh interval and make the last-refresh time visible. Add SSE or another push channel only after defining connection cleanup, backpressure, reconnect behavior, and event filtering. The service's existing WebSocket ingestion remains the source of truth; the dashboard must not introduce a second full-state polling loop against VRChat.

Prefer existing storage methods and SQL aliases that map safely to UI DTOs. Return only fields needed by the screen. Keep timestamps explicit (normally UTC in storage, localize only in the display layer).

## UI implementation guidance

- Build a real responsive surface, not a screenshot: sidebar navigation, status indicators, event feed, online list, empty/loading/error states, and a meaningful refresh interaction.
- Use semantic controls, visible focus/hover states, 44px touch targets on mobile, and `prefers-reduced-motion` for non-trivial animation.
- Keep the first screen glanceable: answer “is the service healthy, who is online, and what just happened?” without decorative fake metrics.
- Escape text rendered with `innerHTML`; do not interpolate raw names, world names, or JSON payloads.
- Keep assets self-contained when deployment simplicity matters; avoid unnecessary frontend dependencies in a Node service plugin.

## Verification checklist

- [ ] Read repository rules before editing.
- [ ] New business UI is in a plugin; core changes are generic infrastructure only.
- [ ] Plugin manifest, entry point, assets, and docs are present.
- [ ] Route registration rejects collisions and route cleanup works on unload/reload.
- [ ] Authentication protects dashboard HTML and API routes.
- [ ] No credentials, tokens, cookies, or personal deployment paths are committed.
- [ ] Server-side limits and output escaping are present.
- [ ] `node --check` passes for every changed JavaScript module.
- [ ] Repository registry/doc-drift tests are run after dependencies are installed; skipped checks are explicitly reported.
- [ ] If a live service exists, probe unauthenticated and authenticated dashboard endpoints and confirm HTTP status/content type.
- [ ] If visual fidelity matters, open the page in a browser and inspect the primary desktop and mobile viewports.

## Common pitfalls

- Putting page-specific business logic directly into `core/http-server.js`.
- Registering routes without removing them during plugin hot reload, causing stale handlers or collisions.
- Returning all database columns instead of a small UI DTO.
- Treating a 200 response from the build as proof that the plugin loaded; verify `/health` plugin status and the actual dashboard route.
- Claiming full tests passed when dependencies or the live deployment were unavailable.
- Building a VRCX clone that assumes a local VRChat client even though the new service runs 24/7 headlessly.

## Session-specific reference

See `references/remote-vrchat-dashboard.md` for the validated architecture pattern, endpoint shape, and verification notes from the first dashboard MVP.
