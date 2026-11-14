# Frame — implementation report

Frame is a multi-user photo-sharing app (feed, explore, search, profiles, follows, likes, comments,
notifications, photo upload) built on FeltKit 0.3.29, starting from `npm create feltkit@latest frame`.
Every number below comes from a command in this repository; the commands are listed so they can be re-run.

## 1. Size: what Frame wrote

Measured with FeltKit's own classifier, `npx feltkit measure` (report kept in `docs/measure.json`).
A line of code is non-blank, non-comment.

| Class | Files | LOC | What it is |
|---|--:|--:|---|
| domain | 6 | 504 | `feltkit/`: data model, ownership rule, 13 queries, 14 mutations |
| experience | 6 | 1,034 | `src/`, `index.html`: React UI and CSS (CSS 227 of it) |
| infrastructure | 1 | 163 | `scripts/seed.ts`: demo data loader (runs through the public HTTP contract; not used at runtime) |
| configuration | 4 | 79 | `package.json`, `tsconfig.json`, … |
| generated | 5 | 76 | typed API (codegen) and unchanged scaffold files |
| **authored total** | **17** | **1,780** | domain + experience + infrastructure + configuration |
| tests | 3 | 460 | integration, artifact and end-to-end tests |

- **Custom runtime infrastructure: 0 lines.** `feltkit measure` reports "Infrastructure findings: none".
  Frame has no server, router, ORM, auth code, session code, upload handler, storage adapter, queue,
  notification store, API layer or MCP server of its own.
- **Workaround code for platform gaps: ≈ 40 lines** — the photo-link cache in `src/lib.tsx`
  (FRAME-GAP-01, 23 lines) and the per-author feed merge in `feltkit/posts.ts` (FRAME-GAP-05, ≈ 15).
- Not measured, and not claimed: how many lines FeltKit "saved". There is no honest baseline for that.

## 2. Platform capabilities used

Each is used through its real contract and exercised by a test.

| # | Capability | How Frame uses it | Evidence |
|--:|---|---|---|
| 1 | FeltDB durable state | 5 collections, one instance per environment | `state survives a restart` (both suites) |
| 2 | FeltDB state contract | `s.ref` references (restrict on delete), 5 unique constraints, 5 indexes, enforced at commit | `CONFLICT` on duplicate username / re-publishing an upload; schema v1 installed by FeltDB at start |
| 3 | Atomic mutations with read fences | likes, follows, post deletion (post + likes + comments in one commit) | `concurrent likes…` tests; activity log shows 3 deletes in one commit |
| 4 | Built-in accounts + cookie sessions | sign-up / sign-in, FeltKit's `<SignIn>` screen | e2e: browser sign-up on phone and desktop; HTTP sign-up |
| 5 | AppPort authorization (roles) | `frame.read` / `frame.write` on every function | anonymous → `UNAUTHORIZED`, role-less → `FORBIDDEN` |
| 6 | `feltkit({ authorize })` | ownership of posts and comments | `FORBIDDEN` for other users and for agents over MCP |
| 7 | AppPort Services Files | photos and avatars; single-use upload links; download links | e2e: real `PUT`/`GET`, JPEG bytes, sandbox CSP |
| 8 | AppPort Services Notifications | likes, comments, follows; per-recipient inbox | notifications reach only the author, never the actor |
| 9 | Transactional outbox (`ctx.afterCommit`) | notifications and jobs only if the mutation commits | job runs once after delete; idempotency keys per record |
| 10 | Jobs | `media.release` removes a deleted post's photo, as the deleter | `runServices()` → 1 job, 0 failed, file marked deleted |
| 11 | Live queries | every screen; feed updates when others act | e2e: another user's comment appears without reload |
| 12 | AppPort capabilities (18) | the Frame API for apps and agents | MCP `tools/list` |
| 13 | MCP for agents | an agent session operates Frame | e2e: agent profile, search, follow, feed, like, comment, post; refused delete |
| 14 | Search (`ctx.db.search`) | people and captions, accent-insensitive | `search finds people and captions` |
| 15 | Codegen + typed client | `api.*` in UI, seed and tests | `feltkit measure`: generated API matches regeneration |
| 16 | Test harness | `createTestApp` (real FeltDB per test), `createArtifactTestApp` | 11 tests |
| 17 | Deployment (`feltkit deploy --target container`) | Node/Docker artifact | artifact run standalone: sign-up, upload, post, image, feed |
| 18 | AppBoundry build | `frame.app` compiles; core social logic runs in the artifact | `tests/artifact.test.ts` |
| 19 | Studio | data, capabilities, activity, services at `/_feltkit/` in dev | served by `feltkit dev` (manual inspection; not tested) |

Reused UI from the starter: the theme switch (`src/theme.tsx`, `public/theme.js`) and FeltKit's `<SignIn>`
component (which also renders development sign-in). Icons: `lucide-react` (ISC).

**Not used, and why:** Configuration service (Frame has no runtime settings); webhooks, API keys,
schedules, intelligence (not needed by the product; adding them would be activity, not value);
AuthBoundry delegation (built-in accounts cover a consumer app).

## 3. Tests and results

Run on 2026-11-14 in this repository:

| Command | Tests | Result |
|---|--:|---|
| `npx tsc --noEmit` | — | clean |
| `npm test` (`feltkit test`) | 11 | 11 pass |
| `npm run test:e2e` (`feltkit build` + `feltkit start` on fresh state) | 7 | 7 pass |

Required scenarios → where they are tested:

| Scenario | Test |
|---|---|
| 1 Register / authenticate multiple users | e2e 1 (HTTP sign-up, distinct principals), e2e 6 (browser sign-up) |
| 2 Create and edit profiles | `profiles: create, unique usernames…`; e2e 6 onboarding |
| 3 Upload photographs | e2e 1, 4, 6 (real HTTP `PUT`, browser file input) |
| 4 Create posts | `posts: upload, publish…`; e2e 1, 4, 6 |
| 5 Follow | `follows: …`; e2e 1, 4, 6 |
| 6 Feed composition | `feed: own and followed users' posts only…` (pagination too); e2e 1, 4 |
| 7 Like / unlike | `likes and comments…`; e2e 6 (button in browser) |
| 8 Comment | `likes and comments…`; e2e 4, 6 |
| 9 Notifications | `likes and comments…`; e2e 4 (from agent), e2e 6 (from browser) |
| 10 Search users | `search finds…`; e2e 4 (agent), e2e 6 (browser) |
| 11 Unauthorized mutations fail | `unauthorized mutations…`; e2e 3 (raw HTTP), e2e 4 (agent) |
| 12 Data survives restarts | `state survives a restart`; e2e 7 (real process stop/start; asserts the server was down) |
| 13 Concurrent consistency | `concurrent likes and follows…` (12 users + 8 duplicate taps); e2e 5 (HTTP) |
| 14 Mobile and desktop | e2e 6 (iPhone 13 emulation and 1360×900; layout and no horizontal scroll asserted) |

Nothing in either suite is mocked. One honest qualification: the integration suite redeems upload
links by calling the runtime's own redemption function (what `PUT /api/files/<token>` calls), because
`createTestApp` has no HTTP server; the HTTP transport itself is covered by the e2e suite.

Defects the tests caught during the build (fixed before commit):
1. **Authorization hole:** the ownership rule named `comments:remove`; the function was `social:uncomment` → anyone could delete any comment (see FRAME-GAP-04).
2. Missing `files.delete` permission made the cleanup job fail (the platform's error named the permission).
3. A test harness bug: `npx` did not forward `SIGTERM`, so the first "restart" test was talking to a server that never stopped. The suite now spawns FeltKit directly and asserts the server is down before restarting.

## 4. Agent operation (MCP)

An agent session (`feltkit session create --id curator --type agent --role member`) connects to
`/mcp` and sees Frame's 18 capabilities as tools. With exactly a member's authority it created a
profile, searched for a user, followed them, read its feed, liked and commented (the human author
received the three notifications), uploaded a photo through `posts_uploadlink` + HTTP `PUT`, and
published it. Its attempt to delete another user's post was refused `FORBIDDEN`. There is no agent
backdoor: the agent goes through the same roles and the same `authorize` hook as the browser. AppPort
Services operations (e.g. `notifications.send`) are not exposed as tools, so an agent cannot forge
notifications. (e2e test 4.)

## 5. Deployment

| Path | Status | Evidence |
|---|---|---|
| `feltkit deploy --target container` (Node/Docker, state on a volume) | **Works** | FeltKit's own boot check passed; the artifact, installed standalone with `npm ci --omit=dev` and run with `npm start`, served sign-up, upload, post, image download and SPA routes |
| Docker image (`docker compose up --build`) | Not verified | No Docker daemon in this environment |
| `feltkit build --target appboundry` | Builds; **not deployable for Frame's core feature** | Photos (FRAME-GAP-02) and self-service accounts (FRAME-GAP-03) are not available in AppBoundry hosts |
| Managed FeltDB (`--target hosted`) | Contract generates; not deployed | Publishing to the real Managed FeltDB account configured in this environment was not authorized |

## 6. Known limitations (Frame's own)

- Post timestamps are set by the server at creation; seeded content therefore shows as recent.
- The feed cursor is `createdAt`: two posts by followed authors in the same millisecond at a page boundary could be skipped. Later feed pages are fixed when loaded, so a post that is pushed off page 1 by a new post is not shown again until refresh.
- Comments on a post are loaded all at once (no comment pagination); notification inbox is capped at 100.
- No direct messages, stories, saved posts, private accounts, blocking, reporting, or e-mail verification (FeltKit supports e-mail verification with a Mailerport service; Frame does not configure one).
- Display: the post detail letterboxes photos on black.

## 7. Platform gaps

10 recorded in [`docs/GAP-REGISTER.md`](GAP-REGISTER.md): 2 high (both AppBoundry), 5 medium, 3 low.
Worked around in app code: FRAME-GAP-01, 05, 06, 08, 09 (and 04 by tests). Not worked around: 02, 03
(deploy with the Node target instead), 07 and 10 (no action needed at this scale).

**New APIs or integrations implemented by Frame:** none. No FeltKit package was modified.
