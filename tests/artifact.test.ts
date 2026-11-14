/**
 * Frame compiled for AppBoundry (`npx feltkit build --target appboundry` → frame.app), run in
 * FeltKit's reference artifact host. Skipped when frame.app has not been built.
 *
 * What it shows: the social graph, likes, comments, search and ownership rules run unchanged in the
 * WebAssembly artifact; photo upload and download do not, because AppBoundry hosts do not serve
 * file links (docs/GAP-REGISTER.md, FRAME-GAP-02).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createArtifactTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

const ARTIFACT = "frame.app";
const member = (id: string) => ({ id, type: "user" as const, roles: ["member"] });

test("frame.app: profiles, follows, search and ownership run in the artifact; photo links do not", { skip: !existsSync(ARTIFACT) && "frame.app not built" }, async () => {
  const t = await createArtifactTestApp(ARTIFACT);
  try {
    const maya = t.as(member("maya"));
    const leo = t.as(member("leo"));
    await maya.mutation(api.profiles.create, { username: "maya", displayName: "Maya" });
    const leoId = await leo.mutation(api.profiles.create, { username: "leo", displayName: "Leo" });
    await assert.rejects(t.as(member("x")).mutation(api.profiles.create, { username: "maya", displayName: "dup" }), { code: "CONFLICT" });
    await maya.mutation(api.social.follow, { profileId: leoId });
    assert.equal((await maya.query(api.profiles.get, { username: "leo" }))!.followerCount, 1);
    assert.deepEqual((await maya.query(api.profiles.search, { text: "leo" })).map((p) => p.username), ["leo"]);
    await assert.rejects(maya.mutation(api.posts.remove, { id: "someone-elses" }), { code: "FORBIDDEN" });

    // The gap: no upload link, so no photo can be posted on an AppBoundry host today.
    await assert.rejects(maya.mutation(api.posts.uploadLink), { code: "UNAVAILABLE" });
  } finally {
    await t.close();
  }
});
