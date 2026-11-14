import { fail, s } from "@feltdb/feltkit";
import { app, follows, posts, profiles } from "./app.js";
import { Author, author, myProfile, ownImage, requireProfile } from "./_frame.js";

const ProfileView = s.doc(profiles).omit("__version", "userId").extend({
  postCount: s.integer(),
  followerCount: s.integer(),
  followingCount: s.integer(),
  followedByMe: s.boolean(),
  isMe: s.boolean(),
});

/** The signed-in caller's own profile, or null before they choose a username. */
export const me = app.query({
  access: "frame.read",
  returns: s.nullable(s.doc(profiles).omit("__version")),
  handler: async (ctx) => {
    const p = await myProfile(ctx);
    if (!p) return null;
    const { __version, ...rest } = p;
    return rest;
  },
});

/** Claim a username. One profile per account; usernames are unique (FeltDB enforces both). */
export const create = app.mutation({
  access: "frame.write",
  args: { username: profiles.shape.username, displayName: profiles.shape.displayName, bio: profiles.shape.bio },
  returns: s.string(),
  capability: { name: "profiles.create", description: "Create the caller's Frame profile with a unique username." },
  handler: async (ctx, { username, displayName, bio }) => {
    const userId = ctx.auth.requirePrincipal().id;
    if (await myProfile(ctx)) fail("FAILED_PRECONDITION", "You already have a profile.");
    if ((await ctx.db.find(profiles, { username })).length) fail("CONFLICT", `@${username} is taken.`);
    return ctx.db.insert(profiles, { userId, username, displayName: displayName.trim(), ...(bio?.trim() ? { bio: bio.trim() } : {}), createdAt: Date.now() });
  },
});

/** Edit the caller's own profile. There is no id argument: nobody can name another profile. */
export const update = app.mutation({
  access: "frame.write",
  args: { displayName: s.optional(profiles.shape.displayName), bio: s.optional(s.string({ maxLength: 300 })), avatarFileId: s.optional(s.string()) },
  capability: { name: "profiles.update", description: "Edit the caller's display name, bio or avatar." },
  returns: s.object({ id: s.string() }),
  handler: async (ctx, { displayName, bio, avatarFileId }) => {
    const me = await requireProfile(ctx);
    if (avatarFileId !== undefined && avatarFileId !== me.avatarFileId) {
      await ownImage(ctx, avatarFileId, me.userId, "avatar");
      // The old picture is removed by a job, only if this commits.
      if (me.avatarFileId) ctx.afterCommit.jobs.enqueue("media.release", { fileId: me.avatarFileId });
    }
    await ctx.db.patch(profiles, me.id, {
      ...(displayName !== undefined ? { displayName: displayName.trim() } : {}),
      ...(bio !== undefined ? { bio: bio.trim() || undefined } : {}),
      ...(avatarFileId !== undefined ? { avatarFileId } : {}),
    });
    return { id: me.id };
  },
});

/** A single-use link the browser PUTs a new profile picture to. */
export const avatarUploadLink = app.mutation({
  access: "frame.write",
  returns: s.object({ url: s.string(), expiresAt: s.string() }),
  handler: async (ctx) => {
    await requireProfile(ctx);
    return ctx.services.files.uploadLink({ metadata: { purpose: "avatar" }, maxBytes: 1024 * 1024 });
  },
});

/** A profile by username, with its counts and whether the caller follows it. */
export const get = app.query({
  access: "frame.read",
  args: { username: s.string() },
  returns: s.nullable(ProfileView),
  capability: { name: "profiles.get", description: "A Frame profile by username: bio, post, follower and following counts." },
  handler: async (ctx, { username }) => {
    const [p] = await ctx.db.find(profiles, { username: username.toLowerCase() });
    if (!p) return null;
    const me = await myProfile(ctx);
    const [postCount, followerCount, followingCount, mine] = await Promise.all([
      ctx.db.count(posts, { authorId: p.id }),
      ctx.db.count(follows, { followeeId: p.id }),
      ctx.db.count(follows, { followerId: p.id }),
      me ? ctx.db.find(follows, { followerId: me.id, followeeId: p.id }) : [],
    ]);
    const { __version, userId, ...rest } = p;
    return { ...rest, postCount, followerCount, followingCount, followedByMe: mine.length > 0, isMe: me?.id === p.id };
  },
});

/** People by username or name. */
export const search = app.query({
  access: "frame.read",
  args: { text: s.string({ minLength: 1, maxLength: 60 }) },
  returns: s.array(Author),
  capability: { name: "profiles.search", description: "Find Frame users by username or display name." },
  handler: async (ctx, { text }) => (await ctx.db.search(profiles, { text, limit: 20 })).map(author),
});

/** Recent people the caller does not follow yet. */
export const suggested = app.query({
  access: "frame.read",
  args: { limit: s.optional(s.integer({ minimum: 1, maximum: 30 })) },
  returns: s.array(Author),
  handler: async (ctx, { limit = 8 }) => {
    const me = await myProfile(ctx);
    const following = new Set(me ? (await ctx.db.find(follows, { followerId: me.id })).map((f) => f.followeeId) : []);
    const recent = await ctx.db.find(profiles, {}, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 200 });
    return recent.filter((p) => p.id !== me?.id && !following.has(p.id)).slice(0, limit).map(author);
  },
});

const connections = (side: "followers" | "following") =>
  app.query({
    access: "frame.read",
    args: { profileId: s.string() },
    returns: s.array(Author),
    handler: async (ctx, { profileId }) => {
      const edges = await ctx.db.find(follows, side === "followers" ? { followeeId: profileId } : { followerId: profileId }, { orderBy: [{ field: "createdAt", direction: "desc" }] });
      const people = await Promise.all(edges.map((e) => ctx.db.get(profiles, side === "followers" ? e.followerId : e.followeeId)));
      return people.filter((p) => p !== null).map(author);
    },
  });

export const followers = connections("followers");
export const following = connections("following");
