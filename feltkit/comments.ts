/**
 * Comments are conversations: replies form threads, each comment has its own reactions, edits and
 * deletion. A comment deleted while it has replies becomes a tombstone (its text is erased) so the
 * thread stays whole; one with no replies is removed.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, comments, profiles, reactions } from "./app.js";
import { CommentView, commentView, myProfile, record, requireProfile, requireVisiblePost } from "./_frame.js";
import { addComment } from "./_social.js";

const authorOwns = { collection: comments, id: "id", field: "authorId", via: { collection: profiles, field: "userId" } } as const;

export const create = app.mutation({
  access: "frame.write",
  args: { postId: s.string(), text: s.string({ minLength: 1, maxLength: 1000 }), parentId: s.optional(s.string()) },
  returns: s.string(),
  capability: { name: "comments.create", description: "Comment on a post the caller can see, or reply to a comment on it (parentId). @username mentions notify; mentioning @scout asks Scout to join." },
  handler: async (ctx, { postId, text, parentId }) => {
    const me = await requireProfile(ctx);
    const post = await requireVisiblePost(ctx.db, postId, me);
    return addComment(ctx, me, post, { text, ...(parentId ? { parentId } : {}) });
  },
});

export const update = app.mutation({
  access: "frame.write",
  args: { id: s.string(), text: s.string({ minLength: 1, maxLength: 1000 }) },
  returns: s.object({ id: s.string() }),
  owner: authorOwns,
  capability: { name: "comments.update", description: "Edit the text of one of the caller's own comments." },
  handler: async (ctx, { id, text }) => {
    const c = (await ctx.db.get(comments, id))!;
    if (c.deletedAt) fail("NOT_FOUND", "That comment does not exist.");
    if (!text.trim()) fail("INVALID_ARGUMENT", "A comment needs some text.");
    await ctx.db.patch(comments, id, { text: text.trim(), editedAt: Date.now() });
    return { id };
  },
});

export const remove = app.mutation({
  access: "frame.write",
  args: { id: s.string() },
  returns: s.object({ id: s.string(), tombstone: s.boolean() }),
  owner: authorOwns,
  capability: { name: "comments.delete", description: "Delete one of the caller's own comments (replies to it stay)." },
  handler: async (ctx, { id }) => {
    const c = (await ctx.db.get(comments, id))!;
    for (const r of await ctx.db.find(reactions, { target: `comment:${id}` })) await ctx.db.delete(reactions, r.id);
    const replies = await ctx.db.count(comments, { parentId: id });
    if (replies) await ctx.db.patch(comments, id, { text: "", deletedAt: Date.now() });
    else {
      await ctx.db.delete(comments, id);
      // A tombstone whose last reply just went is removed too, up the thread.
      let parentId = c.parentId;
      while (parentId) {
        const parent = await ctx.db.get(comments, parentId);
        if (!parent?.deletedAt || (await ctx.db.find(comments, { parentId })).some((x) => x.id !== id)) break;
        await ctx.db.delete(comments, parentId);
        parentId = parent.parentId;
      }
    }
    const me = (await myProfile(ctx))!;
    await record(ctx, me, "comment.deleted", { postId: c.postId, commentId: id });
    return { id, tombstone: replies > 0 };
  },
});

/** Every comment on a post the caller can see, oldest first, with parentId for threading. */
export const thread = app.query({
  access: "frame.read",
  args: { postId: s.string() },
  returns: s.array(CommentView),
  capability: { name: "comments.thread", description: "The conversation on a post: every comment and reply (parentId), with authors (people and agents) and reactions." },
  handler: async (ctx, { postId }) => {
    const me = await myProfile(ctx);
    await requireVisiblePost(ctx.db, postId, me);
    const all = await ctx.db.find(comments, { postId }, { orderBy: [{ field: "createdAt", direction: "asc" }], limit: 500 });
    return Promise.all(all.map((c) => commentView(ctx.db, c, me?.id ?? null)));
  },
});
