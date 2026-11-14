/**
 * Shared rules for Frame's functions: who the caller is, and the shapes Frame publishes.
 * Not a function module (the leading underscore).
 */
import { fail, s, type DatabaseReader, type Doc, type QueryCtx } from "@feltdb/feltkit";
import { comments, likes, posts, profiles } from "./app.js";

export type ProfileDoc = Doc<typeof profiles.shape>;
export type PostDoc = Doc<typeof posts.shape>;
type CommentDoc = Doc<typeof comments.shape>;

/** The caller's profile, or null before they have chosen a username. */
export async function myProfile(ctx: QueryCtx): Promise<ProfileDoc | null> {
  const [me] = await ctx.db.find(profiles, { userId: ctx.auth.requirePrincipal().id });
  return me ?? null;
}

/** The caller's profile; refuses callers who have not created one yet. */
export async function requireProfile(ctx: QueryCtx): Promise<ProfileDoc> {
  return (await myProfile(ctx)) ?? fail("FAILED_PRECONDITION", "Create your Frame profile first.");
}

export const Author = s.doc(profiles).pick("id", "username", "displayName", "avatarFileId");
export const CommentView = s.object({ id: s.string(), text: s.string(), createdAt: s.number(), author: Author, mine: s.boolean() });
export const PostCard = s.doc(posts).pick("id", "fileId", "caption", "width", "height", "createdAt").extend({
  author: Author,
  likeCount: s.integer(),
  commentCount: s.integer(),
  likedByMe: s.boolean(),
  mine: s.boolean(),
  comments: s.array(CommentView),
});
export const FeedPage = s.object({ posts: s.array(PostCard), nextCursor: s.nullable(s.number()) });
export const GridItem = s.doc(posts).pick("id", "fileId", "width", "height", "createdAt").extend({ likeCount: s.integer(), commentCount: s.integer() });
export const GridPage = s.object({ posts: s.array(GridItem), nextCursor: s.nullable(s.number()) });

export function author(p: ProfileDoc) {
  return { id: p.id, username: p.username, displayName: p.displayName, ...(p.avatarFileId ? { avatarFileId: p.avatarFileId } : {}) };
}

export async function commentViews(db: DatabaseReader, list: CommentDoc[], meId: string | null) {
  return Promise.all(list.map(async (c) => ({ id: c.id, text: c.text, createdAt: c.createdAt, author: author((await db.get(profiles, c.authorId))!), mine: c.authorId === meId })));
}

/** Posts as the feed shows them: author, counts, whether I liked it, the latest comments. */
export function cards(db: DatabaseReader, list: PostDoc[], meId: string | null, commentLimit = 2) {
  return Promise.all(
    list.map(async (p) => {
      const [a, likeCount, commentCount, myLike, recent] = await Promise.all([
        db.get(profiles, p.authorId),
        db.count(likes, { postId: p.id }),
        db.count(comments, { postId: p.id }),
        meId ? db.find(likes, { postId: p.id, profileId: meId }) : [],
        commentLimit ? db.query(comments, { where: [{ field: "postId", eq: p.id }], orderBy: [{ field: "createdAt", direction: "desc" }], limit: commentLimit }) : { records: [] },
      ]);
      return {
        id: p.id, fileId: p.fileId, caption: p.caption, width: p.width, height: p.height, createdAt: p.createdAt,
        author: author(a!), likeCount, commentCount, likedByMe: myLike.length > 0, mine: p.authorId === meId,
        comments: await commentViews(db, recent.records.reverse(), meId),
      };
    }),
  );
}

export function gridItems(db: DatabaseReader, list: PostDoc[]) {
  return Promise.all(
    list.map(async (p) => ({
      id: p.id, fileId: p.fileId, width: p.width, height: p.height, createdAt: p.createdAt,
      likeCount: await db.count(likes, { postId: p.id }),
      commentCount: await db.count(comments, { postId: p.id }),
    })),
  );
}

/** One page of posts newest-first, `before` a createdAt cursor, from one author or everyone. */
export async function page(db: DatabaseReader, opts: { authorId?: string; before?: number; limit: number }) {
  const where = [
    ...(opts.authorId ? [{ field: "authorId", eq: opts.authorId }] : []),
    ...(opts.before !== undefined ? [{ field: "createdAt", lt: opts.before }] : []),
  ];
  const { records } = await db.query(posts, { where, orderBy: [{ field: "createdAt", direction: "desc" }], limit: opts.limit + 1 });
  const items = records.slice(0, opts.limit);
  return { items, nextCursor: records.length > opts.limit ? items[items.length - 1]!.createdAt : null };
}

/** The image type the bytes actually are (JPEG, PNG, WebP, GIF), whatever the uploader claimed. */
export function imageType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** An upload the caller made for `purpose`, whose bytes are an image; refuses anything else. */
export async function ownImage(ctx: { services: { files: import("@feltdb/feltkit").FilesReader } }, fileId: string, ownerId: string, purpose: "post" | "avatar") {
  const read = await ctx.services.files.read(fileId).catch(() => null);
  if (!read || read.file.owner !== ownerId || read.file.metadata.purpose !== purpose) fail("FORBIDDEN", "That upload is not yours.");
  if (!imageType(read!.bytes)) fail("INVALID_ARGUMENT", "Only JPEG, PNG, WebP or GIF images can be used.");
  return read!.file;
}
