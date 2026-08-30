# VRChat Dashboard — VRCX-aligned iterations (v2+)

Session detail extending `references/remote-vrchat-dashboard.md` (the first MVP). Applies to the psenY fork of vrchat-assistant, deployed to an OpenWrt router docker (container `vrchat-assistant`, node:22-slim).

## Display-name normalization (the `usr_xxx` leak)

Root cause: `/api/dashboard/events` LEFT JOINed `friends` (so it had `display_name`), but `/api/dashboard/friend-events` read raw `events` rows only — when the historical event row had an empty `display_name`, the DTO fell back to `usr_xxx`. Same person = name in one endpoint, raw id in another.

Fix (apply to BOTH endpoints, not just the feed):
- Core service helper: `getDashboardFriend(userId)` → `SELECT display_name, avatar_image_url, user_icon FROM friends WHERE user_id=?` (used by friend-events).
- events feed: `SELECT e.*, f.display_name AS friendDisplayName, f.avatar_image_url AS avatarUrl, ...` and `displayName = row.display_name || row.friendDisplayName || user.displayName || row.user_id || '系统'`.
- friend-events: `displayName = row.display_name || friend?.displayName || row.user_id || '系统'`; also add `avatarUrl` from the friend snapshot.
- Frontend belt-and-suspenders: `nameFor(x)` — if `x.displayName` is present AND not `/^usr_[a-z0-9-]+$/i`, use it; else re-resolve from `state.friends` by userId; else the raw id / `未知用户`. Apply everywhere a user name renders (event rows, friend rows, world list, profile modal header).

## Reusing MCP tools for dashboard data

Routes needing data beyond the read-only snapshot services reuse existing MCP tools via `api.tools.call(name, args)` — no duplicated VRChat API logic, auth/rate-limit/error handling stay in core:
- `GET /api/dashboard/profile-changes?userId=&limit=` → `get_friend_profile_changes`
- `GET /api/dashboard/groups?userId=` → `get_user_groups`
- `GET /api/dashboard/notifications?limit=&types=` → `get_notifications`
- `POST /api/dashboard/notifications/see` (JSON body `{notificationId}`) → `see_notification` (only low-risk write; hide/accept-friend-request stay out of the dashboard because they carry confirm/destructive semantics).

Forward the tool result verbatim — don't re-wrap. Clamp `limit` server-side at the plugin layer too (`parseLimit` helper: non-finite → fallback, truncate, clamp to [1, max]).

## Stats / charts (no external chart library)

Core `dashboard.stats` service does cheap SQL aggregation (never pulls the full table): GROUP BY type, GROUP BY `substr(created_at,1,10)` (UTC day), top-friends by event count, online count. `GET /api/dashboard/stats?days=` clamps 1..90. Frontend renders self-contained SVG bars (`<svg viewBox>` + `<rect>`/`<text>`, labels sampled every ~12th index) and CSS bar rows. Keep the plugin dependency-free.

## SSE push (validated end-to-end)

- Core: `EventPipeline._storeEvent` gained an optional `onStoredEvent` hook (try/catch, no-op without a subscriber — does not affect the WS ingestion path). In `registerCoreServices`, create a `dashboard.bus` singleton (`subscribe`/`emit`/`count`) as a core service and wire `ctx.eventPipeline.onStoredEvent = (dto) => dashboardBus.emit(dto)`.
- Plugin route `GET /api/dashboard/stream`: `writeHead` with `text/event-stream; charset=utf-8`, `no-cache`, `keep-alive`, `X-Accel-Buffering: no`; write `retry: 5000\n\n` + `data: {"type":"connected"}\n\n`; subscribe → write `data: {type:'event', event:dto}\n\n`; 15s heartbeat comment `: ping\n\n`; `req.on('close')` → clearInterval + unsubscribe + `res.end()`.
- Frontend: `EventSource(api('/api/dashboard/stream'))` — token rides the query string, which the shared auth-guard middleware already accepts (`?token=`). `onopen` sets LIVE in the status bar, `onmessage` throttles a full `load()` to ≤5s per event, `onerror` marks reconnecting (EventSource auto-reconnects). KEEP the 30s `setInterval` polling as the fallback so a broken stream never freezes the UI.

## Router deployment & verification (node:22-slim has NO curl)

1. Package the working copy in memory; exclude `.git`, `node_modules`, `data`, `backups`, `__pycache__`, `.env`, `credentials.json`, `auth_cookie.txt`, `notify-config.json`, `*.sqlite3*`. SFTP upload → `mkdir -p /opt/vrchat-assistant && tar -xzf ... -C /opt/vrchat-assistant && rm -f ...` → `cd /opt/vrchat-assistant && docker-compose up -d --build`.
2. Long docker builds exceed the 600s foreground cap → run the whole deploy as a **background** process (`notify_on_complete=true`) and wait on it; don't re-fire a second deploy on a local script bug — fix and re-run once.
3. Wait for `docker inspect --format '{{.State.Status}} {{.State.Health.Status}}'` to end with `healthy` before probing.
4. Authenticated probes run via `docker exec vrchat-assistant node -e "<script>"` using `process.env.VRC_MONITOR_AUTH_TOKEN` (never print it). Base64-encode the JS payload to avoid shell/quote-hell (curl is not in the slim image).
5. Verify deployed identity: `sha256sum` the same files locally and `docker exec ... sha256sum /app/...` — must match.
6. Confirm unauthenticated `/dashboard` → 401 application/json, authenticated `/health` → 200 `ok:true` + `ws connected` + plugin `loaded`. For SSE, fetch the stream and assert `text/event-stream` + the `connected` event.

## Deployment hygiene

- A legacy repo-adjacent `deploy.py` hardcodes the router SSH password — never copy that pattern. Read the password from an env var / user-provided value; keep it out of scripts, commits, logs, and the final reply. Do not read it back out of pasted/other files.
- Deployment scripts run under terminal's system `python3` (paramiko is installed there); keep the credential as a process-local variable only.
- Test the dashboard plugin route registration in isolation with a mock `api` object (fake `consume`/`tools.call` returning Promises) to catch the await regression before shipping to the router.
