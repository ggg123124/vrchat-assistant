# Refactoring an overgrown dashboard plugin (internal modularization)

Session-tested pattern for when a dashboard plugin outgrows its single-file form.
Context: `web-dashboard` reached 502-line `index.js` with 23 HTTP routes + a 77KB
`dashboard.html` (64 JS functions, 18 async, ~106 `data-*` bindings). User reported
"开发/修 bug 越来越难" and later a regressed build showed "前端功能几乎都没有反应".

## Decision: single plugin, internal modules — NOT a nested plugin loader

Do not build a second plugin system inside the plugin (discovery, lifecycle,
permission, hot-reload). There is no user-facing "enable/disable sub-feature" need
here. Instead:

```text
plugins/official/<name>/
├── index.js                      # thin composition + core routes + SSE + disposer
├── server/
│   ├── http.js                   # sendJson / sendHtml / parseLimit / readJsonBody
│   ├── state.js                  # createDashboardState + CACHE_TTLS + getCached/setCached
│   └── routes/
│       ├── search.js             # export function registerSearchRoutes(api)
│       ├── favorites.js          # export function registerFavoriteRoutes(api, state)
│       ├── avatars.js
│       └── social.js
└── client/
    ├── dashboard.css             # extracted styles
    └── js/{util.js, app.js}      # extracted scripts
```

Route modules take `(api, dashboardState)`; `index.js` calls each once inside
`register(api)` and returns a disposer. HTTP paths and response shapes stay byte-identical.

## PITFALL: cache state must mutate IN PLACE, never reassign

If `register()` destructures stable refs (`const {avatars: avatarsCache} = state`),
then `setCached` must do `state[key].at = …; state[key].data = …`. A first version
that did `state[key] = {at, data}` silently reassigns the module's copy and breaks
every later `getCached` read — and it is a *runtime* TypeError on a const, so
`node --check` will NOT catch it. Only a mock-register smoke test that executes
routes catches it.

## Frontend asset extraction WITHOUT a build tool

No bundler, no static-file route, no new dependency at runtime:

1. Move CSS/JS out of the HTML verbatim into `client/` files.
2. Put placeholders in the HTML: `<script>__DASHBOARD_JS__</script>`,
   `<style id="dashboard-css">__DASHBOARD_CSS__</style>`.
3. At serve time in `index.js`:
   `readFileSync(html).replaceAll('__X__', readFileSync(asset))`.
   Keep ONE `<script>` block (shared scope — plain function declarations still work).
4. **Use `replaceAll`, not `replace`.** If CSS extraction collapses two `<style>`
   blocks into two identical placeholder tags, `.replace` fixes only the first and
   the second survives as literal text in the served page.

Zero-behavior-change discipline (this is what prevents "前端没反应"):
- Move bytes verbatim first (no reformatting, no logic edits in the same commit).
- After splitting, the re-joined file must re-parse with the SAME top-level body
  count as the original (`acorn` body length) and pass `node --check`.
- Locally simulate the serve-time injection (`readFileSync`+`replaceAll`), extract
  the `<script>` block, `node --check` it.
- Deploy, then probe from inside the container: fetch `/dashboard`, extract the
  served script, `node --check` it, and hit each key endpoint expecting 200.

## NEVER hand-roll a JS tokenizer to split minified single-line JS

A hand-written string-state scanner (tracking `' " \`` and comments) is unreliable
here because template literals contain nested `${...}` which can hold quotes and
nested backticks — the scanner drifts out of state and reports 0 functions / bogus
`;` boundaries. The reliable method:

1. Dev-only: `npm install acorn --no-save` in a scratch dir (not deployed).
2. `acorn.parse(src, {ecmaVersion:2022, sourceType:'script'})` → every node carries
   exact `start`/`end` byte offsets → slice precise top-level statements to move.
3. Dependency audit via AST walk — the naive "collect all Identifiers" over-reports
   every method name and object key. Correct handling:
   - `MemberExpression`: walk `object`; walk `property` only if `computed`.
   - `Property` (object literal): walk `value`; walk `key` only if `computed`.
   - params: add `Identifier`, `AssignmentPattern.left`, `RestElement.argument`.
   - `VariableDeclarator`: `id` is a declaration (incl. ObjectPattern/ArrayPattern).

Frontend note: most "functions" in a minified bundle are `const x = (...) => …`
arrow-function declarations, NOT `function` declarations — a regex looking for
`function ` finds almost nothing useful.

## Verification summary that worked

- Local: `node --check` every module; mock `register(api)` smoke → route count
  equals pre-refactor (e.g. 23), no duplicates, `disposer` is a function.
- Project checks `node test-registry.mjs` / `scripts/check-doc-drift.py --json`
  need `better-sqlite3`; in a dep-less work copy they fail to load — report
  honestly as skipped, never as passing.
- Router deploy: tar.gz via paramiko SFTP → `docker-compose up -d --build` →
  poll `docker inspect` until `running healthy` (timeout-bounded).
