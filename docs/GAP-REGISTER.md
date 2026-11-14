# Frame — platform gap register

Gaps found while building Frame on FeltKit 0.3.29 (`@feltdb/feltkit`, `create-feltkit` 0.3.29,
`@appport/services` as pinned by FeltKit, FeltDB 0.21.0). Each entry says what Frame needed, what the
platform provides, what Frame did instead, and the evidence. No FeltKit package was modified.

Severity: **High** — blocks a core feature on a supported path. **Medium** — Frame works, with a
workaround or a known cost. **Low** — friction or an inconsistency.

| ID | Gap | Capability | Severity | Workaround |
|---|---|---|---|---|
| FRAME-GAP-01 | Photo links are uncacheable and new on every issue | Files (file links) | Medium | Client-side link cache in `src/lib.tsx` |
| FRAME-GAP-02 | AppBoundry artifacts cannot upload or serve files | AppBoundry / Files | High | Deploy with the Node/container target |
| FRAME-GAP-03 | AppBoundry artifacts cannot sign people up or in (FK-GAP-013) | AppBoundry / accounts | High | Deploy with the Node/container target |
| FRAME-GAP-04 | Per-record rules are keyed by function-name strings | `feltkit({ authorize })` | Medium | Explicit map + tests for each entry |
| FRAME-GAP-05 | No `in` / set queries; a feed is one query per followed author | FeltDB `ctx.db.query` | Medium | Merge per-author pages |
| FRAME-GAP-06 | No image derivatives (thumbnails, sizes) | Files | Medium | Browser downscales before upload; grids load full images |
| FRAME-GAP-07 | Text search is a linear scan | `ctx.db.search` | Low (at demo scale) | None needed yet |
| FRAME-GAP-08 | Notifications list has no limit or cursor | Notifications | Low | Read all, slice to 100 |
| FRAME-GAP-09 | No after-commit file removal | Files / outbox | Low | `ctx.afterCommit.jobs` + a job mutation |
| FRAME-GAP-10 | MCP `tools/list` shows FeltKit agent tools the caller cannot call | MCP / AppPort | Low | None (calls are refused) |

---

### FRAME-GAP-01 — Photo links are uncacheable and new on every issue
- **Capability:** AppPort Services Files via FeltKit file links (`ctx.services.files.link`, `GET /api/files/<token>`).
- **Why Frame needs it:** a feed shows dozens of photos and is a live query that re-runs whenever a like or comment changes. Photos must load once and stay loaded.
- **Platform today:** each `files.link()` call mints a new token URL (≤ 1 h). Downloads are sent with `Cache-Control: private, no-store` (`packages/sdk/src/server/index.ts`, file-link handler). A query that returned links would hand the browser new URLs on every re-run, each re-downloaded in full.
- **Workaround:** Frame's queries return file ids, not links. `posts:media` issues a 1-hour link per photo, and `usePhotoUrl` in `src/lib.tsx` asks once per photo per page load and reuses the URL until near expiry (23 lines of app code that belong in the platform).
- **Evidence:** `e2e/frame.e2e.test.mjs` asserts the `no-store` header and that two issues for the same file yield different URLs.
- **Recommended resolution:** content-addressed, cacheable download URLs for files whose read authority is stable (e.g. `files.link(id, { cache: "immutable" })` keyed by checksum, or a `public-to-members` read policy on the file), plus a React `useFileUrl(fileId, authorizingQuery)` hook that caches by file id.

### FRAME-GAP-02 — AppBoundry artifacts cannot upload or serve files
- **Capability:** AppBoundry artifact target; Files.
- **Why Frame needs it:** posting a photo is the product.
- **Platform today:** `files.link` and `files.uploadLink` throw `UNAVAILABLE` in the guest (`packages/sdk/src/appboundry/guest.ts`: "File links … need FeltKit's Node server"). `files.upload` with bytes as a function argument exists, but sending multi-MB photos as JSON arguments is not a viable browser path, and downloads have no route at all.
- **Workaround:** none inside AppBoundry. Frame deploys with `feltkit deploy --target container` (verified below). Everything else in Frame runs in the artifact.
- **Evidence:** `tests/artifact.test.ts` runs the compiled `frame.app`: profiles, unique usernames, follows, search and the ownership rule pass; `posts:uploadLink` is refused with `UNAVAILABLE`.
- **Recommended resolution:** an AppBoundry host interface for file transfer (`files-links@1`) that serves the same `PUT`/`GET /api/files/<token>` contract.

### FRAME-GAP-03 — AppBoundry artifacts cannot sign people up or in
- **Capability:** AppBoundry; built-in accounts (`auth.accounts`). Already tracked by FeltKit as **FK-GAP-013**.
- **Why Frame needs it:** a consumer social app needs self-service sign-up.
- **Platform today:** `feltkit build --target appboundry` warns: `/api/auth/*` is not served by any AppBoundry host; operators issue sessions.
- **Workaround:** Node/container deployment.
- **Evidence:** the build output (recorded in `docs/REPORT.md`).
- **Recommended resolution:** the proposed `accounts@1` host interface.

### FRAME-GAP-04 — Per-record rules are keyed by function-name strings
- **Capability:** `feltkit({ authorize })`.
- **Why Frame needs it:** "only the author can delete a post / comment".
- **Platform today:** the hook receives `function: "<module>:<export>"` and the app matches names. A renamed or moved function silently falls out of the rule and becomes unrestricted for anyone with the role.
- **This happened while building Frame:** the hook named `comments:remove`, the function was `social:uncomment`, and any member could delete any comment. The test `unauthorized mutations are refused at the boundary` caught it before commit.
- **Workaround:** an explicit name→collection map in `feltkit/app.ts` and a test per entry.
- **Recommended resolution:** declare ownership on the function (e.g. `app.mutation({ owner: { collection: posts, id: "id", field: "authorId", principal: …} })`), or have FeltKit refuse to start when the hook references a function that does not exist.

### FRAME-GAP-05 — No set membership in queries
- **Capability:** FeltDB `ctx.db.query` (`where` supports `eq`, `neq`, `lt`, `lte`, `gt`, `gte`).
- **Why Frame needs it:** the home feed is "posts whose author is in the set I follow, newest first".
- **Workaround:** `posts:feed` reads one page per followed author through the `(authorId, createdAt)` index and merges them. Cost is linear in the number of people followed; fine at demo scale, wrong at Instagram scale.
- **Recommended resolution:** an `in` clause with index-merge ordering, or a fan-out-on-write primitive (a per-user timeline maintained transactionally).

### FRAME-GAP-06 — No image derivatives
- **Capability:** Files.
- **Platform today:** bytes in, the same bytes out. No resizing, no thumbnails, no metadata stripping.
- **Workaround:** the browser downscales to 1440 px JPEG before upload (`prepareImage`, which also drops EXIF); profile grids load the full image.
- **Recommended resolution:** derivative variants on the Files service (`files.link(id, { variant: "w320" })`), produced by a job.

### FRAME-GAP-07 — Search is a linear scan
- `ctx.db.search` scans every record matching its equality `where` (documented; FeltDB has no text index — FeltKit's own UPSTREAM-GAPS). Frame's people and caption search are global, so they scan the collection. Fine for the demo; needs a text index for growth.

### FRAME-GAP-08 — Notifications list is unbounded
- `ctx.services.notifications.list()` takes `{ unread, type }` only. `inbox:list` reads everything and keeps the newest 100; `inbox:markAllRead` marks one at a time.
- **Recommended resolution:** `limit`/`cursor` and `markAllRead()` on the service.

### FRAME-GAP-09 — No after-commit file removal
- Removing a deleted post's photo with `ctx.services.files.remove` inside the mutation would remove it even if the commit later failed. `ctx.afterCommit` offers notifications, webhooks, jobs and agents, not files.
- **Workaround (platform-supported):** `ctx.afterCommit.jobs.enqueue("media.release", …)` runs `posts:releaseMedia` after commit, as the person who deleted the post; it removes the file only if nothing references it. Required granting `files.delete` and `jobs.create`/`jobs.execute` to members — the platform's error named the exact missing permission.
- **Recommended resolution:** `ctx.afterCommit.files.remove(id)`.

### FRAME-GAP-10 — MCP discovery lists tools the caller cannot call
- An agent session with only the `member` role sees `feltkit_agent_*` tools in `tools/list`; calling one returns `FORBIDDEN: Missing permission: feltkit.agent.read`. Authority is enforced, so this is cosmetic, but FeltKit's README says platform `tools/list` "shows only what the profile grants", and app MCP does not behave the same way.

---

## Observed, not gaps

- **Session issuance in production needs an operator.** `feltkit session create --env production` against a running server is refused ("admin API answers verified operators only"); with the server stopped it opens the state directly. Correct security posture; the e2e test follows it.
- **Live queries after sign-in.** The browser's change stream is refused (401) before sign-in. The e2e test proves queries are live after sign-in (another user's comment appears without reload).
- **Managed FeltDB.** `feltkit contract` produces a contract for Frame, AppPort Services collections included. Not deployed: this session's environment holds credentials for a real Managed FeltDB account, and publishing a contract there is an external action that was not authorized.
- **Docker.** The container artifact was verified by running its Node entry point standalone. `docker compose up --build` was not run: no Docker daemon in this environment.
