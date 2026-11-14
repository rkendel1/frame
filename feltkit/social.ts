/**
 * Likes, comments and follows. Every write acts as the caller's own profile (derived from the
 * verified principal; no argument names the actor), so nobody can like, comment or follow on
 * someone else's behalf. Notifications go through AppPort Services Notifications, only if the
 * write commits (ctx.afterCommit), deduplicated by the record they announce.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, comments, follows, likes, posts, profiles } from "./app.js";
import { requireProfile } from "./_frame.js";

const LikeState = s.object({ liked: s.boolean(), likeCount: s.integer() });

export const like = app.mutation({
  access: "frame.write",
  args: { postId: s.string() },
  returns: LikeState,
  capability: { name: "posts.like", description: "Like a post as the caller (idempotent)." },
  handler: async (ctx, { postId }) => {
    const me = await requireProfile(ctx);
    const post = (await ctx.db.get(posts, postId)) ?? fail("NOT_FOUND", "That post does not exist.");
    const count = await ctx.db.count(likes, { postId });
    if ((await ctx.db.find(likes, { postId, profileId: me.id })).length) return { liked: true, likeCount: count };
    const id = await ctx.db.insert(likes, { postId, profileId: me.id, createdAt: Date.now() });
    const author = (await ctx.db.get(profiles, post.authorId))!;
    if (author.id !== me.id) {
      ctx.afterCommit.notifications.send({ recipient: author.userId, type: "post.liked", title: `${me.username} liked your photo.`, data: { actorId: me.id, postId }, idempotencyKey: `like:${id}` });
    }
    return { liked: true, likeCount: count + 1 };
  },
});

export const unlike = app.mutation({
  access: "frame.write",
  args: { postId: s.string() },
  returns: LikeState,
  capability: { name: "posts.unlike", description: "Remove the caller's like from a post (idempotent)." },
  handler: async (ctx, { postId }) => {
    const me = await requireProfile(ctx);
    const mine = await ctx.db.find(likes, { postId, profileId: me.id });
    for (const l of mine) await ctx.db.delete(likes, l.id);
    return { liked: false, likeCount: await ctx.db.count(likes, { postId }) };
  },
});

export const comment = app.mutation({
  access: "frame.write",
  args: { postId: s.string(), text: comments.shape.text },
  returns: s.string(),
  capability: { name: "comments.create", description: "Comment on a post as the caller." },
  handler: async (ctx, { postId, text }) => {
    const me = await requireProfile(ctx);
    const post = (await ctx.db.get(posts, postId)) ?? fail("NOT_FOUND", "That post does not exist.");
    const body = text.trim();
    if (!body) fail("INVALID_ARGUMENT", "A comment needs some text.");
    const id = await ctx.db.insert(comments, { postId, authorId: me.id, text: body, createdAt: Date.now() });
    const author = (await ctx.db.get(profiles, post.authorId))!;
    if (author.id !== me.id) {
      ctx.afterCommit.notifications.send({ recipient: author.userId, type: "post.commented", title: `${me.username} commented: ${body.slice(0, 80)}`, data: { actorId: me.id, postId, commentId: id }, idempotencyKey: `comment:${id}` });
    }
    return id;
  },
});

/** Ownership is checked by feltkit({ authorize }) before this runs. */
export const uncomment = app.mutation({
  access: "frame.write",
  args: { id: s.string() },
  returns: s.object({ id: s.string() }),
  capability: { name: "comments.delete", description: "Delete one of the caller's own comments." },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(comments, id);
    return { id };
  },
});

const FollowState = s.object({ following: s.boolean() });

export const follow = app.mutation({
  access: "frame.write",
  args: { profileId: s.string() },
  returns: FollowState,
  capability: { name: "follows.create", description: "Follow a user (by profile id) as the caller. Idempotent; you cannot follow yourself." },
  handler: async (ctx, { profileId }) => {
    const me = await requireProfile(ctx);
    if (profileId === me.id) fail("FAILED_PRECONDITION", "You can't follow yourself.");
    const them = (await ctx.db.get(profiles, profileId)) ?? fail("NOT_FOUND", "No such user.");
    // (followerId, followeeId) is unique in FeltDB; this read makes a repeat a no-op instead of CONFLICT.
    if ((await ctx.db.find(follows, { followerId: me.id, followeeId: profileId })).length) return { following: true };
    const id = await ctx.db.insert(follows, { followerId: me.id, followeeId: profileId, createdAt: Date.now() });
    ctx.afterCommit.notifications.send({ recipient: them.userId, type: "user.followed", title: `${me.username} started following you.`, data: { actorId: me.id }, idempotencyKey: `follow:${id}` });
    return { following: true };
  },
});

export const unfollow = app.mutation({
  access: "frame.write",
  args: { profileId: s.string() },
  returns: FollowState,
  capability: { name: "follows.delete", description: "Stop following a user (by profile id) as the caller." },
  handler: async (ctx, { profileId }) => {
    const me = await requireProfile(ctx);
    for (const f of await ctx.db.find(follows, { followerId: me.id, followeeId: profileId })) await ctx.db.delete(follows, f.id);
    return { following: false };
  },
});
