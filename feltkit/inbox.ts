/**
 * The caller's notifications, kept by AppPort Services Notifications: each principal reads and
 * marks only its own (the service enforces it). Frame adds the actor's profile for display.
 */
import { s } from "@feltdb/feltkit";
import { app, profiles } from "./app.js";
import { Author, author } from "./_frame.js";

const Item = s.object({
  id: s.string(),
  type: s.string(),
  title: s.string(),
  createdAt: s.string(),
  read: s.boolean(),
  postId: s.nullable(s.string()),
  actor: s.nullable(Author),
});

export const list = app.query({
  access: "notifications.read",
  returns: s.array(Item),
  capability: { name: "notifications.inbox", description: "The caller's notifications (likes, comments, new followers), newest first." },
  handler: async (ctx) => {
    const all = await ctx.services.notifications.list({});
    const sorted = all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, 100);
    return Promise.all(
      sorted.map(async (n) => {
        const actor = typeof n.data?.actorId === "string" ? await ctx.db.get(profiles, n.data.actorId) : null;
        return { id: n.id, type: n.type, title: n.title, createdAt: n.createdAt, read: Boolean(n.readAt), postId: typeof n.data?.postId === "string" ? n.data.postId : null, actor: actor ? author(actor) : null };
      }),
    );
  },
});

export const unreadCount = app.query({
  access: "notifications.read",
  returns: s.integer(),
  handler: async (ctx) => (await ctx.services.notifications.list({ unread: true })).length,
});

export const markAllRead = app.mutation({
  access: "notifications.update",
  returns: s.integer(),
  handler: async (ctx) => {
    const unread = await ctx.services.notifications.list({ unread: true });
    for (const n of unread) await ctx.services.notifications.markRead(n.id);
    return unread.length;
  },
});
