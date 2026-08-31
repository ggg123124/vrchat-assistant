# Feed Pagination + SSE View-Scoped Refresh + Race Guard

Session-validated patterns for the VRChat Assistant dashboard feed (2026-08).
Verified on the router Docker deployment; page JS `node --check` passed, endpoint probe showed two paged batches with zero overlap.

## 1. Backend offset pagination

`dashboard.events` service (start-monitor.js) is a local SQLite query — cheap, no VRChat rate-limit cost — so pagination is free:

```js
loader.services.set('dashboard.events', ({ limit = 50, offset = 0 } = {}) => {
  const rows = ctx.storage.query(`SELECT ... ORDER BY e.created_at DESC LIMIT $limit OFFSET $offset`,
    { $limit: Math.min(Math.max(Number(limit)||50,1),200), $offset: Math.max(Number(offset)||0,0) });
  ...
});
```

Route passes offset through (clamp + parseInt). Same pattern applies to any list-backed service.

## 2. Frontend feed pagination (load-more)

Keep feed state separate from the shared event state:

- `state.feedEvents` (page 1) + `state.feedHasMore` + `state.loadingMore` guard
- `load()` fills `feedEvents` from `events?limit=50`; sets `feedHasMore = length >= 50`; mirrors into `state.events` so user-lookup (`state.events.find(...)`) keeps working
- `loadMoreFeed()`: `get('/api/dashboard/events?limit=50&offset='+state.feedEvents.length)` → append → `render()`
- `render()` feed branch renders `feedEvents` (fallback `state.events`) and appends a `data-load-more` button when `feedHasMore`; bind `onclick=loadMoreFeed` inside the same render binding block
- `.load-more` CSS: full-width dashed-border muted button

Probe check: `offset=0` and `offset=10` batches must have zero event-id overlap.

## 3. SSE view-scoped refresh

SSE events already triggered a debounced full `load()` (5s), which re-renders the current view — so "real-time current view" mostly worked. The improvement is to make the feed view refresh *faster and cheaper*:

```js
function onSseEvent(dto){
  const now=Date.now();
  if(state.view==='feed'){ if(now-sseRefreshAt>1000){ sseRefreshAt=now; refreshFeedEvents(); } }
  else if(now-sseRefreshAt>5000){ sseRefreshAt=now; load(); }
  renderSse();
}
async function refreshFeedEvents(){
  try{ const d=await get('/api/dashboard/events?limit=50');
    if(d.events){ state.feedEvents=d.events; state.feedHasMore=d.events.length>=50; state.events=state.feedEvents;
      if(state.view==='feed') render(); } }catch{}
}
```

Rationale: `events` is a local DB query (no VRChat limit cost), so the feed can refresh on a 1s debounce while other views keep the 5s full `load()` (side panel/connection state).

**Do NOT attempt incremental top-insertion**: the SSE DTO is only `{type, userId, displayName, worldId, worldName, createdAt}` — it lacks `location`, `avatarUrl`, `status`, `platform` that `eventRow` needs. Building a partial row renders broken rows. Re-fetch-and-replace is correct here.

## 4. View-switch race guard (viewToken)

Async view loads race when the user clicks a slow view (favorites) then a fast one (avatars): the slow response returns and overwrites the new view.

```js
let viewToken=0;
function render(){ const token=++viewToken; ... loadFavorites(token); ... }
// every view load:
async function loadFavorites(token){ ...
  const d=await get(...); if(token!==viewToken) return; // stale response — drop
  ...render... }
```

Every `await get(...)` inside each view load needs the `if(token!==viewToken)return;` guard after it. Apply to: loadHome/loadSearch/loadStats/loadNotifications/loadFavorites/loadWorlds/loadModeration/loadAvatars.

## 5. Frontend view-data cache (60s, write-invalidate)

`get()` caches slow view endpoints (home/favorites/avatars/moderation/notifications/recent-worlds/stats) for 60s — switch away and back shows instantly, then background-refreshes. Polled endpoints (overview/friends/events) stay uncached for realtime. After write ops (mark notification seen / respond friend request), call `invalidateViewCache(prefix)` or the stale cached list reappears.
