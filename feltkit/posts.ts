import { fail, s } from "@feltdb/feltkit";
import { app, comments, follows, likes, posts, profiles } from "./app.js";
import { CommentView, FeedPage, GridPage, PostCard, cards, commentViews, gridItems, myProfile, ownImage, page, requireProfile } from "./_frame.js";

/** A single-use link the browser (or an agent) PUTs one photo to, as the caller. */
export const uploadLink = app.mutation({
  access: "frame.write",
  returns: s.object({ url: s.string(), expiresAt: s.string() }),
  capability: { name: "posts.uploadlink", description: "Get a single-use URL to PUT one image (JPEG/PNG/WebP, ≤ 4 MB) to; then call posts.create with the returned file id." },
  handler: async (ctx) => {
    await requireProfile(ctx);
    return ctx.services.files.uploadLink({ metadata: { purpose: "post" } });
  },
});

/** Publish an uploaded photo. Only the uploader can publish it, once. */
export const create = app.mutation({
  access: "frame.write",
  args: { fileId: s.string(), caption: s.string({ maxLength: 2200 }), width: posts.shape.width, height: posts.shape.height },
  returns: s.string(),
  capability: { name: "posts.create", description: "Publish a photo uploaded through posts.uploadlink, with a caption." },
  handler: async (ctx, { fileId, caption, width, height }) => {
    const me = await requireProfile(ctx);
    await ownImage(ctx, fileId, me.userId, "post");
    // posts.fileId is unique: publishing the same upload twice is refused by FeltDB.
    return ctx.db.insert(posts, { authorId: me.id, fileId, caption: caption.trim(), width, height, createdAt: Date.now() });
  },
});

/** Delete a post with its likes and comments in one commit. Ownership: feltkit({ authorize }). */
export const remove = app.mutation({
  access: "frame.write",
  args: { id: s.string() },
  returns: s.object({ id: s.string() }),
  capability: { name: "posts.delete", description: "Delete one of the caller's own posts." },
  handler: async (ctx, { id }) => {
    const post = (await ctx.db.get(posts, id))!;
    for (const l of await ctx.db.find(likes, { postId: id })) await ctx.db.delete(likes, l.id);
    for (const c of await ctx.db.find(comments, { postId: id })) await ctx.db.delete(comments, c.id);
    await ctx.db.delete(posts, id);
    ctx.afterCommit.jobs.enqueue("media.release", { fileId: post.fileId });
    return { id };
  },
});

/** One post with every comment. */
export const get = app.query({
  access: "frame.read",
  args: { id: s.string() },
  returns: s.nullable(PostCard.extend({ comments: s.array(CommentView) })),
  capability: { name: "posts.get", description: "A post with its author, like count and all comments." },
  handler: async (ctx, { id }) => {
    const post = await ctx.db.get(posts, id);
    if (!post) return null;
    const me = await myProfile(ctx);
    const [card] = await cards(ctx.db, [post], me?.id ?? null, 0);
    const all = await ctx.db.find(comments, { postId: id }, { orderBy: [{ field: "createdAt", direction: "asc" }] });
    return { ...card!, comments: await commentViews(ctx.db, all, me?.id ?? null) };
  },
});

/**
 * Home: the caller's and followed people's posts, newest first. Each author's newest page is read
 * through the (authorId, createdAt) index and merged; `cursor` is the last createdAt seen.
 */
export const feed = app.query({
  access: "frame.read",
  args: { cursor: s.optional(s.number()), limit: s.optional(s.integer({ minimum: 1, maximum: 30 })) },
  returns: FeedPage,
  capability: { name: "feed.home", description: "The caller's home feed: their own and followed users' posts, newest first. Pass nextCursor back as cursor for more." },
  handler: async (ctx, { cursor, limit = 10 }) => {
    const me = await myProfile(ctx);
    if (!me) return { posts: [], nextCursor: null };
    const authors = [me.id, ...(await ctx.db.find(follows, { followerId: me.id })).map((f) => f.followeeId)];
    const pages = await Promise.all(authors.map((authorId) => page(ctx.db, { authorId, before: cursor, limit })));
    const merged = pages.flatMap((p) => p.items).sort((a, b) => b.createdAt - a.createdAt);
    const items = merged.slice(0, limit);
    const more = merged.length > limit || pages.some((p) => p.nextCursor !== null);
    return { posts: await cards(ctx.db, items, me.id), nextCursor: more && items.length ? items[items.length - 1]!.createdAt : null };
  },
});

/** Everyone's posts, newest first (Explore). */
export const recent = app.query({
  access: "frame.read",
  args: { cursor: s.optional(s.number()), limit: s.optional(s.integer({ minimum: 1, maximum: 60 })) },
  returns: GridPage,
  capability: { name: "posts.recent", description: "Everyone's most recent posts, newest first." },
  handler: async (ctx, { cursor, limit = 24 }) => {
    const { items, nextCursor } = await page(ctx.db, { before: cursor, limit });
    return { posts: await gridItems(ctx.db, items), nextCursor };
  },
});

/** One person's posts, newest first (the profile grid). */
export const byAuthor = app.query({
  access: "frame.read",
  args: { profileId: s.string(), cursor: s.optional(s.number()), limit: s.optional(s.integer({ minimum: 1, maximum: 60 })) },
  returns: GridPage,
  handler: async (ctx, { profileId, cursor, limit = 24 }) => {
    const { items, nextCursor } = await page(ctx.db, { authorId: profileId, before: cursor, limit });
    return { posts: await gridItems(ctx.db, items), nextCursor };
  },
});

/** Posts whose caption contains every word. */
export const search = app.query({
  access: "frame.read",
  args: { text: s.string({ minLength: 1, maxLength: 100 }) },
  returns: GridPage,
  capability: { name: "posts.search", description: "Find posts whose caption contains every word of the text." },
  handler: async (ctx, { text }) => ({ posts: await gridItems(ctx.db, await ctx.db.search(posts, { text, limit: 30 })), nextCursor: null }),
});

/**
 * A download link for a photo or avatar. Any signed-in member may see any published image, so the
 * rule is: the file must belong to a post or a profile. Unpublished uploads are never linked.
 */
export const media = app.query({
  access: "frame.read",
  args: { fileId: s.string() },
  returns: s.object({ url: s.string(), expiresAt: s.string() }),
  handler: async (ctx, { fileId }) => {
    const [post] = await ctx.db.find(posts, { fileId });
    const owner = post ? null : (await ctx.db.find(profiles, { avatarFileId: fileId }))[0];
    if (!post && !owner) fail("NOT_FOUND", "No such image.");
    return ctx.services.files.link(fileId, { disposition: "inline", expiresInSeconds: 3600 });
  },
});

/**
 * Background job "media.release": removes a photo once nothing refers to it. Queued by
 * posts:remove and profiles:update with ctx.afterCommit, so it runs only if they committed,
 * as the person who queued it (the file's owner).
 */
export const releaseMedia = app.mutation({
  access: "frame.write",
  args: { fileId: s.string() },
  returns: s.object({ removed: s.boolean() }),
  handler: async (ctx, { fileId }) => {
    const inUse = (await ctx.db.count(posts, { fileId })) + (await ctx.db.count(profiles, { avatarFileId: fileId }));
    const file = await ctx.services.files.get(fileId).catch(() => null);
    if (inUse || !file || file.owner !== ctx.auth.requirePrincipal().id) return { removed: false };
    await ctx.services.files.remove(fileId);
    return { removed: true };
  },
});
