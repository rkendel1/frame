/**
 * Frame: a photo-sharing social network on FeltKit.
 *
 * Everything below is declaration. FeltDB stores and enforces the collections (types, references,
 * unique constraints, indexes); AppPort enforces the roles on every interface (HTTP, /appport, /mcp);
 * AppPort Services provides files (photos) and notifications. The one piece of policy Frame writes
 * itself is `authorize`: who owns which record.
 */
import { feltkit, s, type AuthorizeRequest } from "@feltdb/feltkit";

export const app = feltkit({
  name: "frame",
  description: "Frame: share photos, follow people, like and comment.",
  roles: {
    // Every account is a member. frame.read/frame.write are Frame's own permissions; the service
    // permissions are what Frame's functions use on the caller's behalf (photos, notifications).
    member: ["frame.read", "frame.write", "files.read", "files.write", "files.delete", "notifications.read", "notifications.update", "notifications.send", "jobs.create", "jobs.execute"],
    // Studio operators: configure services, read the app. No Frame write access.
    admin: ["frame.read", "configuration.*", "jobs.*", "feltkit.operations.*", "feltkit.agent.*"],
  },
  // Built-in accounts: e-mail + password, scrypt-hashed, sessions in an HttpOnly cookie.
  auth: { accounts: { roles: ["member"] } },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["member", "admin"] },
      { id: "grace", name: "Grace Hopper", roles: ["member"] },
    ],
  },
  services: {
    // Photos up to 4 MB (the browser resizes to 1440 px JPEG before upload; typical 200–600 KB).
    files: { maxBytes: 4 * 1024 * 1024 },
    notifications: { types: ["post.liked", "post.commented", "user.followed"] },
    // Removing a deleted post's photo runs after the delete commits, as the person who deleted it.
    jobs: { handlers: { "media.release": "posts:releaseMedia" } },
  },
  authorize: ownership,
});

export const profiles = app.collection(
  "profiles",
  {
    /** The principal (account) this profile belongs to. One profile per principal. */
    userId: s.string(),
    username: s.string({ minLength: 3, maxLength: 30, pattern: "^[a-z0-9._]+$" }),
    displayName: s.string({ minLength: 1, maxLength: 60 }),
    bio: s.optional(s.string({ maxLength: 300 })),
    avatarFileId: s.optional(s.string()),
    createdAt: s.number(),
  },
  { unique: [["userId"], ["username"]], indexes: [{ fields: ["createdAt"] }], search: ["username", "displayName"] },
);

export const posts = app.collection(
  "posts",
  {
    authorId: s.ref(profiles),
    fileId: s.string(),
    caption: s.string({ maxLength: 2200 }),
    width: s.integer({ minimum: 1 }),
    height: s.integer({ minimum: 1 }),
    createdAt: s.number(),
  },
  { unique: [["fileId"]], indexes: [{ fields: ["authorId", "createdAt"] }, { fields: ["createdAt"] }], search: ["caption"] },
);

export const follows = app.collection(
  "follows",
  { followerId: s.ref(profiles), followeeId: s.ref(profiles), createdAt: s.number() },
  { unique: [["followerId", "followeeId"]], indexes: [{ fields: ["followeeId"] }] },
);

export const likes = app.collection(
  "likes",
  { postId: s.ref(posts), profileId: s.ref(profiles), createdAt: s.number() },
  { unique: [["postId", "profileId"]] },
);

export const comments = app.collection(
  "comments",
  { postId: s.ref(posts), authorId: s.ref(profiles), text: s.string({ minLength: 1, maxLength: 1000 }), createdAt: s.number() },
  { indexes: [{ fields: ["postId", "createdAt"] }] },
);

/**
 * Per-record ownership, enforced for every caller on every interface (HTTP, AppPort, MCP), after
 * the role check and argument validation, before the handler. Every other Frame mutation acts on
 * the caller's own profile, derived from the verified principal, so it cannot name another user.
 * An unknown id is refused exactly like someone else's, so a refusal reveals nothing.
 */
async function ownership({ function: fn, args, principal, db }: AuthorizeRequest) {
  // Function name ("<module>:<export>") → the collection whose record `args.id` must be the caller's.
  // tests/frame.test.ts proves each entry is enforced; a renamed function fails those tests.
  const owned = ({ "posts:remove": posts, "social:uncomment": comments } as const)[fn as "posts:remove"];
  if (!owned) return true;
  const [me] = principal ? await db.find(profiles, { userId: principal.id }) : [];
  const record = await db.get(owned, String(args.id));
  if (me && record?.authorId === me.id) return true;
  return { allowed: false as const, code: "FORBIDDEN" as const, reason: "Only its author can delete this." };
}
