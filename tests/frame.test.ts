/**
 * Frame's behaviour against a real FeltDB instance per test (`feltkit test`): the same runtime,
 * authorization, Files and Notifications services the server uses. Nothing is mocked.
 * Uploads are redeemed through the runtime's own upload-link path (what PUT /api/files/<token>
 * calls); tests/http.test.ts covers the HTTP transport itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
const member = (id: string) => ({ id, type: "user" as const, roles: ["member"] });

async function upload(t: TestApp, who: string, link: { url: string }, bytes = JPEG, contentType = "image/jpeg") {
  const token = link.url.split("/").pop()!;
  return t.runtime.services.redeemUpload(token, async () => bytes, { contentType, name: "photo.jpg" });
}

async function person(t: TestApp, id: string) {
  const me = t.as(member(id));
  const profileId = await me.mutation(api.profiles.create, { username: id, displayName: id[0]!.toUpperCase() + id.slice(1) });
  return { me, profileId };
}

async function post(t: TestApp, id: string, caption: string) {
  const link = await t.as(member(id)).mutation(api.posts.uploadLink);
  const file = await upload(t, id, link);
  return t.as(member(id)).mutation(api.posts.create, { fileId: file.id, caption, width: 1080, height: 1350 });
}

async function withApp(fn: (t: TestApp) => Promise<void>) {
  const t = await createTestApp();
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

test("profiles: create, unique usernames, one per account, edit own only", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    await assert.rejects(t.as(member("other")).mutation(api.profiles.create, { username: "maya", displayName: "Fake" }), { code: "CONFLICT" });
    await assert.rejects(maya.mutation(api.profiles.create, { username: "maya2", displayName: "Again" }), { code: "FAILED_PRECONDITION" });
    await assert.rejects(t.as(member("x")).mutation(api.profiles.create, { username: "Bad Name!", displayName: "x" }), { code: "INVALID_ARGUMENT" });

    await maya.mutation(api.profiles.update, { displayName: "Maya Chen", bio: "Light chaser." });
    const p = await maya.query(api.profiles.get, { username: "maya" });
    assert.equal(p!.displayName, "Maya Chen");
    assert.equal(p!.bio, "Light chaser.");
    assert.equal(p!.isMe, true);

    // update takes no id: another user's update changes only their own profile.
    await person(t, "leo");
    await t.as(member("leo")).mutation(api.profiles.update, { displayName: "Not Maya" });
    assert.equal((await maya.query(api.profiles.get, { username: "maya" }))!.displayName, "Maya Chen");

    // An avatar must be the caller's own image upload.
    const link = await maya.mutation(api.profiles.avatarUploadLink);
    const avatar = await upload(t, "maya", link);
    await assert.rejects(t.as(member("leo")).mutation(api.profiles.update, { avatarFileId: avatar.id }), { code: "FORBIDDEN" });
    await maya.mutation(api.profiles.update, { avatarFileId: avatar.id });
    assert.equal((await maya.query(api.profiles.get, { username: "maya" }))!.avatarFileId, avatar.id);
  }));

test("posts: upload, publish, only real images, only your own upload, once", () =>
  withApp(async (t) => {
    await person(t, "maya");
    await person(t, "leo");
    const maya = t.as(member("maya"));
    const file = await upload(t, "maya", await maya.mutation(api.posts.uploadLink));
    await assert.rejects(t.as(member("leo")).mutation(api.posts.create, { fileId: file.id, caption: "stolen", width: 1, height: 1 }), { code: "FORBIDDEN" });
    const id = await maya.mutation(api.posts.create, { fileId: file.id, caption: "Golden hour", width: 1080, height: 1350 });
    await assert.rejects(maya.mutation(api.posts.create, { fileId: file.id, caption: "again", width: 1, height: 1 }), { code: "CONFLICT" });

    // A file claiming to be a JPEG that is not one is refused.
    const fake = await upload(t, "maya", await maya.mutation(api.posts.uploadLink), new TextEncoder().encode("<script>alert(1)</script>"), "image/jpeg");
    await assert.rejects(maya.mutation(api.posts.create, { fileId: fake.id, caption: "x", width: 1, height: 1 }), { code: "INVALID_ARGUMENT" });

    const detail = await t.as(member("leo")).query(api.posts.get, { id });
    assert.equal(detail!.caption, "Golden hour");
    assert.equal(detail!.author.username, "maya");
    assert.equal(detail!.mine, false);

    // Any member can get a link for a published photo; an unpublished upload has none.
    const link = await t.as(member("leo")).query(api.posts.media, { fileId: file.id });
    assert.match(link.url, /^\/api\/files\/fkf_/);
    await assert.rejects(t.as(member("leo")).query(api.posts.media, { fileId: fake.id }), { code: "NOT_FOUND" });
  }));

test("feed: own and followed users' posts only, newest first, paginated", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    const { profileId: leoId } = await person(t, "leo");
    await person(t, "zoe");
    await post(t, "zoe", "zoe 1");
    for (let i = 1; i <= 5; i++) {
      await post(t, "leo", `leo ${i}`);
      await new Promise((r) => setTimeout(r, 2));
    }
    await post(t, "maya", "maya 1");

    assert.deepEqual((await maya.query(api.posts.feed, {})).posts.map((p) => p.caption), ["maya 1"]);
    await maya.mutation(api.social.follow, { profileId: leoId });
    const first = await maya.query(api.posts.feed, { limit: 4 });
    assert.deepEqual(first.posts.map((p) => p.caption), ["maya 1", "leo 5", "leo 4", "leo 3"]);
    const second = await maya.query(api.posts.feed, { limit: 4, cursor: first.nextCursor! });
    assert.deepEqual(second.posts.map((p) => p.caption), ["leo 2", "leo 1"]);
    assert.equal(second.nextCursor, null);

    await maya.mutation(api.social.unfollow, { profileId: leoId });
    assert.deepEqual((await maya.query(api.posts.feed, {})).posts.map((p) => p.caption), ["maya 1"]);
    // Explore shows everyone.
    assert.equal((await maya.query(api.posts.recent, {})).posts.length, 7);
  }));

test("follows: no self-follow, no duplicates, counts and lists", () =>
  withApp(async (t) => {
    const { me: maya, profileId: mayaId } = await person(t, "maya");
    const { profileId: leoId } = await person(t, "leo");
    await assert.rejects(maya.mutation(api.social.follow, { profileId: mayaId }), { code: "FAILED_PRECONDITION" });
    await maya.mutation(api.social.follow, { profileId: leoId });
    await maya.mutation(api.social.follow, { profileId: leoId });
    const leo = await maya.query(api.profiles.get, { username: "leo" });
    assert.deepEqual([leo!.followerCount, leo!.followedByMe], [1, true]);
    assert.deepEqual((await maya.query(api.profiles.followers, { profileId: leoId })).map((p) => p.username), ["maya"]);
    assert.deepEqual((await maya.query(api.profiles.following, { profileId: mayaId })).map((p) => p.username), ["leo"]);
  }));

test("likes and comments, with notifications to the author only", () =>
  withApp(async (t) => {
    const { profileId: mayaId } = await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const postId = await post(t, "maya", "Fog over the bridge");

    assert.deepEqual(await leo.mutation(api.social.like, { postId }), { liked: true, likeCount: 1 });
    assert.deepEqual(await leo.mutation(api.social.like, { postId }), { liked: true, likeCount: 1 }, "liking twice is a no-op");
    await t.as(member("maya")).mutation(api.social.like, { postId }); // own like: no notification
    let card = (await leo.query(api.posts.get, { id: postId }))!;
    assert.deepEqual([card.likeCount, card.likedByMe], [2, true]);
    assert.deepEqual(await leo.mutation(api.social.unlike, { postId }), { liked: false, likeCount: 1 });

    const commentId = await leo.mutation(api.social.comment, { postId, text: "  Stunning.  " });
    await leo.mutation(api.social.follow, { profileId: mayaId });
    card = (await leo.query(api.posts.get, { id: postId }))!;
    assert.deepEqual(card.comments.map((c) => [c.author.username, c.text, c.mine]), [["leo", "Stunning.", true]]);

    const inbox = await t.as(member("maya")).query(api.inbox.list);
    assert.deepEqual(inbox.map((n) => n.type).sort(), ["post.commented", "post.liked", "user.followed"]);
    assert.ok(inbox.every((n) => n.actor?.username === "leo"));
    assert.equal(inbox.find((n) => n.type === "post.liked")!.postId, postId);
    assert.deepEqual(await leo.query(api.inbox.list), [], "leo receives nothing for his own actions");
    assert.equal(await t.as(member("maya")).query(api.inbox.unreadCount), 3);
    assert.equal(await t.as(member("maya")).mutation(api.inbox.markAllRead), 3);
    assert.equal(await t.as(member("maya")).query(api.inbox.unreadCount), 0);
    assert.ok(commentId);
  }));

test("unauthorized mutations are refused at the boundary", () =>
  withApp(async (t) => {
    await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const postId = await post(t, "maya", "mine");
    const commentId = await t.as(member("maya")).mutation(api.social.comment, { postId, text: "my comment" });

    // Someone else's post and comment: refused by the authorize hook, nothing deleted.
    await assert.rejects(leo.mutation(api.posts.remove, { id: postId }), { code: "FORBIDDEN" });
    await assert.rejects(leo.mutation(api.social.uncomment, { id: commentId }), { code: "FORBIDDEN" });
    await assert.rejects(leo.mutation(api.posts.remove, { id: "no-such-post" }), { code: "FORBIDDEN" });
    assert.equal((await leo.query(api.posts.get, { id: postId }))!.comments.length, 1);

    // Anonymous callers and accounts without the member role get nothing.
    await assert.rejects(t.query(api.posts.recent, {}), { code: "UNAUTHORIZED" });
    await assert.rejects(t.mutation(api.social.like, { postId }), { code: "UNAUTHORIZED" });
    await assert.rejects(t.as({ id: "nobody", type: "user", roles: [] }).mutation(api.social.like, { postId }), { code: "FORBIDDEN" });

    // Undeclared arguments (e.g. trying to name the actor) are rejected by validation.
    await assert.rejects(leo.mutation(api.social.like, { postId, profileId: "maya" } as never), { code: "INVALID_ARGUMENT" });
    await assert.rejects(leo.mutation(api.profiles.update, { userId: "maya", bio: "pwned" } as never), { code: "INVALID_ARGUMENT" });

    // A user without a profile cannot act.
    await assert.rejects(t.as(member("ghost")).mutation(api.social.like, { postId }), { code: "FAILED_PRECONDITION" });

    // The denial is recorded with the resource decision.
    const denied = await t.runtime.activity.list({ name: "posts:remove" });
    assert.ok(denied.some((e) => e.outcome === "denied"));
  }));

test("deleting a post removes its likes and comments atomically, then its photo by a job", () =>
  withApp(async (t) => {
    await person(t, "maya");
    const { me: leo } = await person(t, "leo");
    const postId = await post(t, "maya", "temporary");
    const fileId = (await leo.query(api.posts.get, { id: postId }))!.fileId;
    await leo.mutation(api.social.like, { postId });
    await leo.mutation(api.social.comment, { postId, text: "nice" });
    await t.as(member("maya")).mutation(api.posts.remove, { id: postId });
    assert.equal(await leo.query(api.posts.get, { id: postId }), null);
    const entry = (await t.runtime.activity.list({ name: "posts:remove" }))[0]!;
    assert.deepEqual(entry.writes!.map((w) => w.op).sort(), ["delete", "delete", "delete"]);

    const tick = await t.runtime.runServices();
    assert.deepEqual([tick.jobs, tick.failed.jobs], [1, 0]);
    const [run] = await t.runtime.activity.list({ name: "posts:releaseMedia" });
    assert.deepEqual([run!.outcome, run!.principal?.id], ["success", "maya"], "the job ran as the person who deleted the post");
    const files = await t.runtime.instance.handle("test").collection<{ id: string; status?: string; deletedAt?: string }>("files").find({});
    // AppPort Services Files keeps the record, marked deleted, and FeltKit releases the bytes.
    assert.ok(files.find((f) => f.id === fileId)?.deletedAt, "the photo was removed by the media.release job");
  }));

test("search finds people and captions", () =>
  withApp(async (t) => {
    const { me: maya } = await person(t, "maya");
    await t.as(member("leo")).mutation(api.profiles.create, { username: "leo.alvarez", displayName: "Léo Álvarez" });
    await post(t, "maya", "Morning fog over Lisbon");
    assert.deepEqual((await maya.query(api.profiles.search, { text: "leo" })).map((p) => p.username), ["leo.alvarez"]);
    assert.deepEqual((await maya.query(api.profiles.search, { text: "alvarez" })).map((p) => p.username), ["leo.alvarez"], "accent-insensitive");
    assert.equal((await maya.query(api.posts.search, { text: "lisbon fog" })).posts.length, 1);
    assert.equal((await maya.query(api.posts.search, { text: "paris" })).posts.length, 0);
    assert.deepEqual((await maya.query(api.profiles.suggested, {})).map((p) => p.username), ["leo.alvarez"]);
  }));

test("concurrent likes and follows stay consistent", () =>
  withApp(async (t) => {
    await person(t, "maya");
    const postId = await post(t, "maya", "popular");
    const fans = Array.from({ length: 12 }, (_, i) => `fan${i}`);
    for (const f of fans) await person(t, f);

    // Twelve people like at once; refused commits (CONFLICT, retryable) are retried, as clients do.
    const retry = async <T>(fn: () => Promise<T>): Promise<T> => {
      for (let i = 0; ; i++) {
        try {
          return await fn();
        } catch (e) {
          if ((e as { retryable?: boolean }).retryable && i < 20) continue;
          throw e;
        }
      }
    };
    await Promise.all(fans.map((f) => retry(() => t.as(member(f)).mutation(api.social.like, { postId }))));
    // One person double-taps many times at once: still one like.
    await Promise.all(Array.from({ length: 8 }, () => retry(() => t.as(member("fan0")).mutation(api.social.like, { postId }))));
    assert.equal((await t.as(member("maya")).query(api.posts.get, { id: postId }))!.likeCount, 12);
    const stored = await t.runtime.instance.handle("test").collection<{ postId: string }>("likes").find({});
    assert.equal(stored.length, 12, "exactly one stored like per person");

    const mayaId = (await t.as(member("maya")).query(api.profiles.get, { username: "maya" }))!.id;
    await Promise.all(Array.from({ length: 6 }, () => retry(() => t.as(member("fan1")).mutation(api.social.follow, { profileId: mayaId }))));
    assert.equal((await t.as(member("maya")).query(api.profiles.get, { username: "maya" }))!.followerCount, 1);
  }));

test("state survives a restart", () =>
  withApp(async (t) => {
    await person(t, "maya");
    const { me: leo, profileId: leoId } = await person(t, "leo");
    const postId = await post(t, "maya", "durable");
    await leo.mutation(api.social.like, { postId });
    await t.as(member("maya")).mutation(api.social.follow, { profileId: leoId });
    await t.restart();
    const card = (await t.as(member("leo")).query(api.posts.get, { id: postId }))!;
    assert.deepEqual([card.caption, card.likeCount, card.likedByMe], ["durable", 1, true]);
    assert.equal((await t.as(member("maya")).query(api.profiles.get, { username: "leo" }))!.followedByMe, true);
    assert.equal((await t.as(member("maya")).query(api.inbox.list)).length, 1);
  }));
