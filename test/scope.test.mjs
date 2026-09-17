/**
 * Scopes on the board, and an inbox opened with a gate.
 *
 * A scope key is the read capability and the address derived from it the write
 * capability. The vector is the one every client and the service share. The
 * client is given a fetch that answers as told and records what was sent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Aamio, AamioError, Keys, boardSigningInput, deriveAddress, isScopeKey, newScopeKey, scopeAddress, verify } from "../src/aamio.js";

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));

test("the scope vector, and it is never the thread address of the same string", () => {
  assert.equal(scopeAddress(vectors.scope.key), vectors.scope.address);
  assert.equal(deriveAddress(vectors.scope.key), vectors.scope.thread_w_of_the_same_string);
});

test("a new scope key has the form, and an address is never taken for a key", () => {
  const key = newScopeKey();
  assert.ok(isScopeKey(key) && key.length === 26);
  assert.match(scopeAddress(key), /^[a-z2-7]{20}$/);
  assert.equal(isScopeKey(scopeAddress(key)), false);
  assert.notEqual(newScopeKey(), key);
  assert.throws(() => scopeAddress(vectors.scope.address), TypeError);
});

/** A client whose fetch answers by route and records every request. */
function fake(answers = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    const route = Object.keys(answers).find((prefix) => (init.method + " " + url).startsWith(prefix));
    const [status, body] = route ? answers[route](init) : [404, { error: "no such route in the fake", fix: "none" }];
    return { status, text: async () => JSON.stringify(body) };
  };
  return { client: new Aamio({ keys: Keys.generate(), fetch }), requests };
}

const opened = (init) => [201, { w: "x", expire_at: Math.floor(Date.now() / 1000) + 3600, allow: ["*"] }];

test("a post in a scope carries the address inside what is signed, and never the key", async () => {
  const { client, requests } = fake({
    "PUT https://aamio.at/": opened,
    "GET https://board.aamio.at/.well-known": () => [200, { work: { advise_bits: 0 } }],
    "POST https://board.aamio.at/": (init) => [201, { id: "p".repeat(20), ...JSON.parse(init.body) }],
  });
  const scope = scopeAddress(vectors.scope.key);
  const { post } = await client.board.post({ kind: "need", title: "Chapter 3 draft ready", text: "At commit 4f2a9c1.", tags: ["chapter-03"], scope });
  const sent = requests.find((r) => r.method === "POST" && r.url === "https://board.aamio.at/");

  assert.equal(JSON.parse(sent.body).scope, scope);
  assert.equal(post.scope, scope);
  assert.ok(!sent.body.includes(vectors.scope.key));
  assert.ok(verify(client.keys.public, boardSigningInput(client.keys.public, sent.body), sent.headers["X-Sig"]));
  await assert.rejects(client.board.post({ kind: "need", title: "t", text: "x", scope: vectors.scope.key }), TypeError);
});

test("a find with the key sends it in the body and believes only an answer that names the scope", async () => {
  const address = scopeAddress(vectors.scope.key);
  let answer = [200, { count: 1, live: 1, next: 3, posts: [{ id: "p".repeat(20) }], scope: address }];
  const { client, requests } = fake({ "POST https://board.aamio.at/find": () => answer });

  const page = await client.board.find({ tags: ["chapter-03"], scopeKey: vectors.scope.key });
  const sent = JSON.parse(requests.at(-1).body);

  assert.equal(page.scope, address);
  assert.equal(sent.scope_key, vectors.scope.key);
  assert.equal(sent.scopeKey, undefined);
  assert.ok(!requests.at(-1).url.includes(vectors.scope.key));

  answer = [200, { count: 0, live: 0, next: 0, posts: [] }];
  await assert.rejects(client.board.find({ scopeKey: vectors.scope.key }), (error) => error instanceof AamioError && /did not say it read that scope/.test(error.message));

  answer = [400, { error: "Unknown field scope_key", fix: "Drop that field" }];
  await assert.rejects(client.board.find({ scopeKey: vectors.scope.key }), (error) => error instanceof AamioError && error.status === 400);

  await assert.rejects(client.board.find({ scope: address }), TypeError);
});

test("an inbox opens with a gate in the body of the same request", async () => {
  const gate = { advise: { pow: { bits: 16 } } };
  const { client, requests } = fake({ "PUT https://aamio.at/": (init) => [201, { w: "x", expire_at: 1, allow: ["*"], gate: { advise: { pow: { bits: 16, covers: 1 } } } }] });
  const thread = await client.open({ ttl: 3600, allow: ["*"], gate });
  const sent = requests.at(-1);

  assert.deepEqual(JSON.parse(sent.body), { gate });
  assert.equal(sent.headers["Content-Type"], "application/json");
  assert.equal(sent.headers["X-TTL"], "3600");
  assert.deepEqual(thread.gate, { advise: { pow: { bits: 16, covers: 1 } } });

  await client.open({ ttl: 600 });
  assert.equal(requests.at(-1).body, undefined);
});
