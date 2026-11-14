/**
 * End to end against the production build (`feltkit build` + `feltkit start`) on a fresh state
 * directory: real HTTP, real file transfers, MCP as an agent, a real browser at phone and desktop
 * sizes, a server restart on the same state, and concurrent writers. Nothing is mocked.
 *
 *   npm run test:e2e      (builds first; needs Playwright's Chromium and ImageMagick's `convert`)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createApi, createClient } from "@feltdb/feltkit/client";

const api = createApi();
const require = createRequire(import.meta.url);
const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright").catch(() => require("/opt/node22/lib/node_modules/playwright"));
const PORT = Number(process.env.E2E_PORT ?? 4317);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(join(tmpdir(), "frame-e2e-"));
const PASSWORD = "e2e-password-123";
let server;
const FELTKIT = join(process.cwd(), "node_modules", "@feltdb", "feltkit", "bin", "feltkit.js");
// Local production state only: never a FeltDB server or Managed FeltDB this machine may be configured for.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FELTDB_")));
ENV.FELTKIT_STATE_DIR = join(STATE, "state");

function photo(w = 900, h = 1125, color = "steelblue") {
  const file = join(STATE, `${w}x${h}-${color}.jpg`);
  execFileSync("convert", ["-size", `${w}x${h}`, `gradient:${color}-white`, "-quality", "80", file]);
  return { file, bytes: readFileSync(file) };
}

async function start() {
  // The FeltKit binary itself (not via npx), so stopping it really stops the server.
  server = spawn(process.execPath, [FELTKIT, "start", "--port", String(PORT)], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${BASE}/_feltkit/health`).then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start:\n${log}`);
}
async function stop() {
  if (!server) return;
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await exited;
  server = undefined;
  assert.equal(await fetch(`${BASE}/_feltkit/health`).then(() => "up", () => "down"), "down", "the server really stopped");
}

/** A signed-in client for a new built-in account (bearer session, as a non-browser client). */
async function person(username, { profile = true } = {}) {
  let token = null;
  const client = createClient({ url: BASE, session: "bearer", tokens: { get: () => token, set: (t) => void (token = t) }, context: false });
  await client.signUp({ email: `${username.replace(/\./g, "-")}@e2e.test`, password: PASSWORD, name: username });
  const id = profile ? await client.mutation(api.profiles.create, { username, displayName: username }) : null;
  return Object.assign(client, { profileId: id, username, token: () => token });
}
async function post(client, caption, color) {
  const { bytes } = photo(900, 1125, color);
  const file = await client.uploadFile(await client.mutation(api.posts.uploadLink), bytes, { name: "p.jpg", contentType: "image/jpeg" });
  return client.mutation(api.posts.create, { fileId: file.id, caption, width: 900, height: 1125 });
}
const retrying = async (fn) => {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!e.retryable || i > 25) throw e;
    }
  }
};

before(async () => start());
after(async () => {
  await stop();
  rmSync(STATE, { recursive: true, force: true });
});

let alice, bob, alicePost;

test("accounts, profiles, photo upload over HTTP, feed composition", async () => {
  alice = await person("alice");
  bob = await person("bob");
  const s1 = await alice.session();
  const s2 = await bob.session();
  assert.ok(s1.principal.id && s1.principal.id !== s2.principal.id, "each account is its own principal");

  alicePost = await post(alice, "Harbour at dusk", "darkorange");
  const card = await bob.query(api.posts.get, { id: alicePost });
  // The photo itself, through the link Frame issues: real bytes, an image type, sandboxed.
  const link = await bob.query(api.posts.media, { fileId: card.fileId });
  const res = await fetch(BASE + link.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer()).slice(0, 3)], [0xff, 0xd8, 0xff]);
  assert.equal((await fetch(`${BASE}/api/files/fkf_${"x".repeat(30)}`)).status, 404);

  assert.equal((await bob.query(api.posts.feed, {})).posts.length, 0, "bob follows nobody yet");
  await bob.mutation(api.social.follow, { profileId: alice.profileId });
  assert.deepEqual((await bob.query(api.posts.feed, {})).posts.map((p) => p.caption), ["Harbour at dusk"]);
});

test("a non-image upload cannot become a post; an upload link works once", async () => {
  const link = await alice.mutation(api.posts.uploadLink);
  const file = await alice.uploadFile(link, new TextEncoder().encode("<html>not a photo</html>"), { name: "x.jpg", contentType: "image/jpeg" });
  await assert.rejects(alice.mutation(api.posts.create, { fileId: file.id, caption: "x", width: 1, height: 1 }), { code: "INVALID_ARGUMENT" });
  const again = await fetch(BASE + link.url, { method: "PUT", body: "again" });
  assert.equal(again.status, 404, "single use");
});

test("unauthorized operations are refused over HTTP", async () => {
  const mallory = await person("mallory");
  await assert.rejects(mallory.mutation(api.posts.remove, { id: alicePost }), { code: "FORBIDDEN" });
  const comment = await bob.mutation(api.social.comment, { postId: alicePost, text: "lovely" });
  await assert.rejects(mallory.mutation(api.social.uncomment, { id: comment }), { code: "FORBIDDEN" });
  // Raw HTTP without a session, and with a forged actor argument.
  const anon = await fetch(`${BASE}/api/mutation/social%3Alike`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: { postId: alicePost } }) });
  assert.equal(anon.status, 401);
  await assert.rejects(mallory.mutation(api.social.like, { postId: alicePost, profileId: alice.profileId }), { code: "INVALID_ARGUMENT" });
  assert.equal((await alice.query(api.posts.get, { id: alicePost })).comments.length, 1);
});

test("an agent operates Frame over MCP with a member's authority, no more", async () => {
  // An agent's session is issued by the operator on the host. Against a running production server
  // that needs a verified operator sign-in; with the server stopped the CLI opens the state directly.
  await stop();
  const out = execFileSync(process.execPath, [FELTKIT, "session", "create", "--id", "curator", "--type", "agent", "--role", "member", "--ttl", "1", "--env", "production", "--json"], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  const token = JSON.parse(String(out)).token;
  await start();
  let n = 0;
  const call = async (method, params) => {
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
    const body = JSON.parse((await res.text()).replace(/^data: /m, ""));
    if (body.error) throw Object.assign(new Error(body.error.message), body.error);
    return body.result;
  };
  // A tool result is the capability's JSON output as text; a refusal is isError with "CODE: message".
  const tool = async (name, args = {}) => {
    const r = await call("tools/call", { name, arguments: args });
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  const tools = (await call("tools/list")).tools.map((t) => t.name);
  for (const t of ["feed_home", "posts_create", "posts_like", "comments_create", "follows_create", "profiles_search", "profiles_get"]) assert.ok(tools.includes(t), t);
  assert.ok(!tools.some((t) => /^(notifications_send|files_)/.test(t)), "service operations are not offered to agents");

  await tool("profiles_create", { username: "curator.bot", displayName: "Curator" });
  const [alice_] = await tool("profiles_search", { text: "alice" });
  assert.equal(alice_.username, "alice");
  await tool("follows_create", { profileId: alice_.id });
  const feed = await tool("feed_home", {});
  assert.deepEqual(feed.posts.map((p) => p.caption), ["Harbour at dusk"]);
  await tool("posts_like", { postId: alicePost });
  await tool("comments_create", { postId: alicePost, text: "Featured in today's picks." });
  // The agent posts a photo the way any client does: an upload link, then the bytes over HTTP.
  const link = await tool("posts_uploadlink");
  const put = await fetch(BASE + link.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: photo(800, 800, "seagreen").bytes });
  const fileId = (await put.json()).file.id;
  const agentPost = await tool("posts_create", { fileId, caption: "Curated: soft light", width: 800, height: 800 });
  assert.ok(agentPost);
  // The same ownership boundary as a person: it cannot delete Alice's post.
  await assert.rejects(tool("posts_delete", { id: alicePost }), /FORBIDDEN/);
  assert.ok((await alice.query(api.posts.get, { id: alicePost })) !== null);

  const inbox = await alice.query(api.inbox.list);
  const fromAgent = inbox.filter((i) => i.actor?.username === "curator.bot").map((i) => i.type).sort();
  assert.deepEqual(fromAgent, ["post.commented", "post.liked", "user.followed"]);
});

test("concurrent likes over HTTP keep exact counts", async () => {
  const fans = await Promise.all(Array.from({ length: 10 }, (_, i) => person(`fan${i}`)));
  await Promise.all(fans.map((f) => retrying(() => f.mutation(api.social.like, { postId: alicePost }))));
  await Promise.all(Array.from({ length: 6 }, () => retrying(() => fans[0].mutation(api.social.like, { postId: alicePost }))));
  const card = await alice.query(api.posts.get, { id: alicePost });
  assert.equal(card.likeCount, 11, "ten fans and the curator agent, once each");
});

test("the browser app works on a phone and a desktop, live", async () => {
  const browser = await chromium.launch();
  try {
    for (const [name, options] of [["phone", devices["iPhone 13"]], ["desktop", { viewport: { width: 1360, height: 900 } }]]) {
      const ctx = await browser.newContext(options);
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(BASE);
      // Sign up through FeltKit's sign-in screen, then choose a username.
      await page.getByRole("tab", { name: /create account/i }).or(page.getByRole("button", { name: /create account/i })).first().click();
      await page.getByLabel(/name/i).first().fill(`Web ${name}`).catch(() => undefined);
      await page.getByLabel(/e-?mail/i).first().fill(`web-${name}@e2e.test`);
      await page.getByLabel(/password/i).first().fill(PASSWORD);
      await page.getByRole("button", { name: /create account|sign up/i }).last().click();
      await page.getByLabel("Username").fill(`web.${name}`);
      await page.getByRole("button", { name: "Continue" }).click();

      // Explore → search → follow Alice.
      await page.goto(`${BASE}/explore`);
      await page.getByLabel("Search").fill("alice");
      await page.locator(".person-link", { hasText: "alice" }).first().click();
      await page.getByRole("button", { name: "Follow", exact: true }).click();
      await page.getByRole("button", { name: "Following", exact: true }).waitFor();

      // Home shows Alice's post; like it with the button.
      await page.goto(BASE);
      const card = page.locator("article.card", { hasText: "Harbour at dusk" });
      await card.waitFor();
      await card.locator(".photo.loaded img").waitFor({ timeout: 15000 });
      await card.getByRole("button", { name: "Like" }).click();
      await card.getByRole("button", { name: "Unlike" }).waitFor();

      // Live: someone else comments; the open feed shows it without a reload.
      const text = `Hello from bob to ${name}`;
      await bob.mutation(api.social.comment, { postId: alicePost, text });
      await card.getByText(text).waitFor({ timeout: 10000 });

      // Create a post with a real file, then see it and delete it.
      await page.goto(`${BASE}/create`);
      await page.locator('input[type="file"]').setInputFiles(photo(1600, 1200, "tomato").file);
      await page.getByPlaceholder("Write a caption…").fill(`From the ${name}`);
      await page.getByRole("button", { name: "Share" }).click();
      await page.waitForURL(/\/p\//);
      await page.getByText(`From the ${name}`).waitFor();
      await page.locator(".post-photo.loaded img").waitFor({ timeout: 15000 });
      await page.getByPlaceholder("Add a comment…").fill("First!");
      await page.getByRole("button", { name: "Post", exact: true }).click();
      await page.getByText("First!").waitFor();
      page.once("dialog", (d) => d.accept());
      await page.getByRole("button", { name: "Delete post" }).click();
      await page.waitForURL(new RegExp(`/u/web\\.${name}$`));

      // Alice's notifications include this person's like.
      assert.ok((await alice.query(api.inbox.list)).some((n) => n.actor?.username === `web.${name}` && n.type === "post.liked"));
      assert.deepEqual(errors, [], `no page errors on ${name}`);
      // Layout: bottom bar on the phone, sidebar on the desktop.
      assert.equal(await page.locator(name === "phone" ? ".bottombar" : ".sidebar").isVisible(), true);
      assert.equal(await page.locator(name === "phone" ? ".sidebar" : ".bottombar").isVisible(), false);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `no horizontal scroll on ${name}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});

test("everything survives a server restart on the same state", async () => {
  const before = await alice.query(api.posts.get, { id: alicePost });
  await stop();
  await start();
  await alice.signIn({ email: "alice@e2e.test", password: PASSWORD }).catch(() => undefined);
  const after = await alice.query(api.posts.get, { id: alicePost });
  assert.equal(after.likeCount, before.likeCount);
  assert.equal(after.commentCount, before.commentCount);
  const link = await alice.query(api.posts.media, { fileId: after.fileId });
  assert.equal((await fetch(BASE + link.url)).status, 200, "the photo's bytes survived too");
  assert.ok((await alice.query(api.inbox.list)).length > 0);
});
