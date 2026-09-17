// fetch the way a browser or a Worker calls it: with no receiver but the
// global object. Node's own fetch never checks, so this test stands in for the
// runtimes that do. No network.

import test from "node:test";
import assert from "node:assert/strict";
import { Aamio, Keys } from "../src/aamio.js";

function strictFetch(receivers, answer) {
  // A plain function, so `this` is whatever the caller made it.
  return function (input, init) {
    receivers.push(this);
    if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    return Promise.resolve(new Response(JSON.stringify(answer(input, init)), { status: 200, headers: { "Content-Type": "application/json" } }));
  };
}

test("every request goes out without the client as fetch's receiver", async () => {
  const receivers = [];
  const answers = (input, init) => {
    const url = String(input);
    if (init?.method === "PUT") return { w: url.slice(-20), expire_at: 1, allow: [] };
    if (url.endsWith("/gate")) return {};
    if (url.includes("/receipt")) return { messages: [], root: "", commitment: "" };
    if (init?.method === "POST") return { seq: 1, at: 1, sha256: "", verified: true, count: 1, expire_at: 1 };
    return { w: url.slice(-20), exists: true, count: 0, allow: [], messages: [], next: 0, waited: 0 };
  };
  const me = new Aamio({ keys: Keys.generate(), fetch: strictFetch(receivers, answers) });
  const inbox = await me.open({ ttl: 60 });
  await me.send(inbox.w, "hei");
  await me.read(inbox);
  await me.receipt(inbox);
  assert.ok(receivers.length >= 4, "the calls went through the fetch that was handed in");
  assert.ok(receivers.every((receiver) => receiver === undefined || receiver === globalThis), "and none of them had the client as its receiver");
});

test("the board and presence go through the same fetch", async () => {
  const receivers = [];
  const me = new Aamio({ keys: Keys.generate(), fetch: strictFetch(receivers, () => ({ matches: [], posts: [], count: 0, next: 0, tags: [], live: 0, untagged: {} })) });
  await me.board.find({});
  await me.presence.lookup([me.keys.public]);
  assert.ok(receivers.length >= 2);
  assert.ok(receivers.every((receiver) => receiver === undefined || receiver === globalThis));
});
