# Remote VRChat Dashboard Reference

## Validated data-contract pattern

The service stores event rows with snake_case fields such as `created_at`, `world_name`, and `content_json`, while the UI works better with a compact camelCase DTO. Do not make the browser guess storage fields. Normalize in the core read-only adapter:

```js
{
  eventId,
  type,
  userId,
  displayName,
  createdAt,
  worldId,
  worldName,
  avatarUrl,
  location,
  summary
}
```

Parse `content_json` defensively. Merge avatar data in this order: joined friend snapshot, event user object (`currentAvatarImageUrl` / `iconUrl`), then empty placeholder. Merge world data in this order: event row, parsed event world object, cached/API world lookup, then `worldId` or a clear “not public / pending” label.

Normalize both the global event feed and per-friend event feed. A common regression is normalizing `/events` but leaving `/friend-events` on raw SQLite rows; the Inspector then breaks while the main feed works.

## UI contract and layout

Use an activity row with explicit columns:

```text
time | state marker | avatar | actor + action | world + summary | raw type
```

On mobile, collapse to:

```text
time | marker | avatar | actor/action/world/summary
```

Keep the event row clickable and use its DTO to open the matching friend Inspector. Escape all inserted values. Make missing data explicit (`未公开位置`, `世界名称待更新`) instead of rendering raw `private`, empty strings, or a long JSON blob.

## Failure lessons

- If a page-wide request helper is replaced during a UI patch, verify the helper still exists before deployment. A missing `get()` caused every Dashboard panel to show a generic request failure.
- A 200 HTML response does not prove the page works; run the authenticated API calls and inspect the returned DTO fields.
- When the user reports a visual problem, first reproduce with real endpoint data, then inspect the layout contract. Do not only add more decoration or cards.
- Keep the event feed and Inspector changes in one coherent pass, but verify each endpoint separately.

## Deployment verification recipe

1. Run `node --check` for every changed JS module and `git diff --check`.
2. Upload a source archive while excluding `.env`, credentials, cookies, SQLite files, WAL files, backups, `.git`, and `node_modules`.
3. Rebuild with `docker-compose up -d --build`.
4. Wait for the container to become `healthy`.
5. Probe authenticated `/dashboard`, `/api/dashboard/overview`, `/api/dashboard/events`, `/api/dashboard/friends`, and `/api/dashboard/friend-events`.
6. Print a small sample of `/api/dashboard/events` and confirm it contains `createdAt`, `displayName`, `worldName/worldId`, `avatarUrl`, and `summary`.
7. Report skipped tests honestly when dependencies are unavailable; do not infer visual correctness from HTTP status alone.
