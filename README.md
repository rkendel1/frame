# Frame

A photo-sharing social network — feed, explore, search, profiles, follows, likes, comments,
notifications and photo upload — built on [FeltKit](https://www.npmjs.com/package/@feltdb/feltkit).

```bash
npm create feltkit@latest frame     # where this started (first commit)
```

Frame's server side is 504 lines in `feltkit/`. FeltKit provides the database (FeltDB), accounts and
sessions, authorization on every interface, file storage, notifications, background jobs, live
queries, an AppPort API, MCP for agents, the dashboard and the deployable build.
See [docs/REPORT.md](docs/REPORT.md) for the measured breakdown and evidence, and
[docs/GAP-REGISTER.md](docs/GAP-REGISTER.md) for what the platform does not do yet.

## Run it

```bash
npm install
npm run dev
```

In another terminal, load the demo people and photos (downloads ~40 photos from Unsplash; add
`-- --generated` to use generated images offline):

```bash
npm run seed
```

Open http://localhost:3000 and sign in as `demo@frame.example` / `frame-demo-password`, or create an
account. Every demo person signs in as `<username with dots as dashes>@frame.example` with the same
password (e.g. `maya-okafor@frame.example`). These are development credentials: don't seed a public
deployment without changing `PASSWORD` in `scripts/seed.ts`.

The dashboard (FeltKit Studio) link is printed by `npm run dev`.

## Test it

```bash
npm test             # 11 tests: real FeltDB per test, plus the AppBoundry artifact if built
npm run test:e2e     # 7 tests: production build, HTTP, MCP agent, browser (phone + desktop), restart
```

`test:e2e` needs Playwright's Chromium and ImageMagick (`convert`).

## Deploy it

```bash
npx feltkit deploy --target container
docker compose -f .feltkit/deploy/docker-compose.yml up --build    # or: cd .feltkit/deploy && npm ci --omit=dev && npm start
```

The app and its FeltDB state run in one container with the data on a volume.
`.feltkit/deploy/DEPLOY.md` (written by the deploy) covers configuration, persistence, upgrades and
rollback; FeltKit's other targets (Fly, Vercel, Cloudflare, Managed FeltDB) are listed by
`npx feltkit deploy --help`.

**AppBoundry:** `npx feltkit build --target appboundry` builds `frame.app`, but AppBoundry hosts do not
yet serve file transfers or self-service accounts, so Frame cannot post photos there
(FRAME-GAP-02/03).

## Agents

```bash
npx feltkit session create --id curator --type agent --role member
```

Point an MCP client at `http://localhost:3000/mcp` with that token. The agent gets Frame's 18
capabilities (`feed_home`, `posts_create`, `posts_like`, `comments_create`, `follows_create`,
`profiles_search`, `profiles_get`, …) with exactly a member's authority: it acts as its own profile and
cannot touch anyone else's posts.

## Layout

```
feltkit/app.ts        data model (5 collections), roles, services, ownership rule
feltkit/posts.ts      upload links, publish, delete, feed, explore, search, photo links, cleanup job
feltkit/social.ts     likes, comments, follows (+ notifications after commit)
feltkit/profiles.ts   profiles, search, suggestions, followers/following
feltkit/inbox.ts      notifications
feltkit/_frame.ts     shared shapes and helpers
src/                  React UI (App.tsx shell, pages.tsx screens, components.tsx, lib.tsx)
scripts/seed.ts       demo data, through the public HTTP contract only
tests/, e2e/          tests
docs/                 report, gap register, seed photo sources
```

## Data model

| Collection | Fields | Constraints |
|---|---|---|
| profiles | userId, username, displayName, bio?, avatarFileId?, createdAt | unique userId; unique username (`[a-z0-9._]{3,30}`); search on username, displayName |
| posts | authorId → profiles, fileId, caption, width, height, createdAt | unique fileId; index (authorId, createdAt), (createdAt); search on caption |
| follows | followerId → profiles, followeeId → profiles, createdAt | unique (followerId, followeeId) |
| likes | postId → posts, profileId → profiles, createdAt | unique (postId, profileId) |
| comments | postId → posts, authorId → profiles, text, createdAt | index (postId, createdAt) |

Photos are AppPort Services Files; notifications are AppPort Services Notifications. Counts are
computed (`count`), never stored. FeltDB enforces references (restrict on delete), uniqueness and types.

**Authorization.** Every function needs `frame.read` or `frame.write` (members hold both). No mutation
takes an actor argument: the actor is always the verified caller's own profile. Deleting a post or
comment additionally requires being its author (`authorize` in `feltkit/app.ts`). Uploads can only be
published by their uploader, once, and only if the bytes are really an image.

Photos in the demo: Unsplash License; sources in [docs/SEED-PHOTOS.md](docs/SEED-PHOTOS.md).
