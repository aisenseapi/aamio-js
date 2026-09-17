/**
 * Gate from the writer's side: what this client does about an inbox's conditions.
 *
 * The same vectors as the service and the Python client, and a client whose
 * fetch is a fake that answers as told and records what was sent. The rules
 * come from the gate specification of 16 September 2026.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Aamio, AamioError, DEFAULT_BASE, GateStop, POW_ADVISE_MAX_BITS, POW_REQUIRE_MAX_BITS, gatePlan, hex, powDigest, powInput, sha256hex, solveWork, zeroBits } from "../src/aamio.js";

const W = "b4netymg7r5nnt2yiscp";
const KEY = "A".repeat(43);
const BODY = '{"post":"abc","reply_to":"xyz","text":"hei"}';
const BODY_SHA256 = "36751f20147f74e3dfbaf829fb8f04ea9ed596268bd685a69fdfa5992fddd6b8";
const REQUIRE_8 = { require: { pow: { bits: 8, covers: 1 } } };

// ------------------------------------------------------------------ vectors

test("the shared vectors", () => {
  assert.equal(sha256hex(BODY), BODY_SHA256);

  const signed = powDigest(W, KEY, BODY_SHA256, "7036");
  const unsigned = powDigest(W, "", BODY_SHA256, "91617");

  assert.equal(hex(signed), "00003a2ac769f2265d621969d9ff1feaaa2b9dcc6f006b6adae1d22c2db8a842");
  assert.equal(zeroBits(signed), 18);
  assert.equal(hex(unsigned), "000018b5cc286cf27d2c97296aff9e2e60db0c165e7cf3af7a44857423c08612");
  assert.equal(zeroBits(unsigned), 19);
});

test("an unsigned message has an empty key, and two line breaks meet", () => {
  assert.ok(powInput(W, "", BODY_SHA256, "91617").includes("\n\n"));
  assert.equal(powInput(W, null, BODY_SHA256, "1"), powInput(W, "", BODY_SHA256, "1"));
});

test("zero bits count from the top bit of the first byte", () => {
  assert.equal(zeroBits(new Uint8Array(32)), 256);
  assert.equal(zeroBits(Uint8Array.of(0x00, 0x0f, ...new Array(30).fill(0xff))), 12);
  assert.equal(zeroBits(Uint8Array.of(0x80, ...new Array(31).fill(0))), 0);
  assert.equal(zeroBits(Uint8Array.of(0x01, ...new Array(31).fill(0xff))), 7);
});

test("solveWork gives the first nonce that reaches the bits", () => {
  const nonce = solveWork(W, KEY, BODY, 8);
  assert.ok(zeroBits(powDigest(W, KEY, BODY_SHA256, nonce)) >= 8);
  for (let n = 0; n < Number(nonce); n++) assert.ok(zeroBits(powDigest(W, KEY, BODY_SHA256, String(n))) < 8);
});

test("the ceilings are the service's", () => {
  assert.deepEqual([POW_REQUIRE_MAX_BITS, POW_ADVISE_MAX_BITS], [20, 18]);
});

// --------------------------------------------------------------------- plan

test("no gate asks for nothing", () => {
  assert.deepEqual(gatePlan({}), { bits: null, required: false, notes: [] });
  assert.deepEqual(gatePlan(null), { bits: null, required: false, notes: [] });
});

test("advised work at the ceiling is done without asking, and required work at its ceiling is done", () => {
  assert.deepEqual(gatePlan({ advise: { pow: { bits: 18, covers: 1 } } }), { bits: 18, required: false, notes: [] });
  assert.deepEqual(gatePlan({ require: { pow: { bits: 20, covers: 1 } } }), { bits: 20, required: true, notes: [] });
});

test("a requirement over the ceiling stops, and says why", () => {
  assert.throws(() => gatePlan({ require: { pow: { bits: 21, covers: 1 } } }), (error) => error instanceof GateStop && error.reason.includes("21") && error.reason.includes("20") && Boolean(error.fix));
});

test("advice over the ceiling is passed over and mentioned", () => {
  const advice = gatePlan({ advise: { pow: { bits: 19, covers: 1 } } });
  assert.equal(advice.bits, null);
  assert.ok(advice.notes.some((note) => note.includes("19")));
});

test("an unknown condition under require stops, under advise it goes ahead and says so", () => {
  assert.throws(() => gatePlan({ require: { toll: "any" } }, W), (error) => error instanceof GateStop && error.reason.includes("toll") && error.fix.includes(W));

  const advice = gatePlan({ advise: { pow: { bits: 8, covers: 1 }, fresh: 60 } });
  assert.equal(advice.bits, 8);
  assert.ok(advice.notes.some((note) => note.includes("fresh")));
});

test("an unknown bucket stops, and the hard limits need no work", () => {
  assert.throws(() => gatePlan({ demand: { pow: { bits: 8 } } }), GateStop);
  assert.deepEqual(gatePlan({ require: { per_key: 1, write_until: 1800000000 } }), { bits: null, required: false, notes: [] });
});

// ------------------------------------------------------------------- client

/** A client whose fetch answers the gate given and then the posts in order, and records every request. */
function fake(gate, answers) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.endsWith("/gate")) {
      return gate === null ? { status: 404, text: async () => JSON.stringify({ error: "No thread", fix: "open it" }) } : { status: 200, text: async () => JSON.stringify(gate) };
    }
    const [status, body] = answers.length ? answers.shift() : [201, { seq: 1, at: 1, w: W }];
    return { status, text: async () => JSON.stringify(body) };
  };
  return { client: new Aamio({ fetch }), requests, posts: () => requests.filter((r) => r.method === "POST") };
}

const refusedWithGate = (gate) => [428, { error: "This inbox requires proof of work of 8 bits", bits: 8, fix: "do the work", gate }];

const reaches = (post, bits) => zeroBits(powDigest(W, post.headers["X-Key"] || "", sha256hex(post.body), post.headers["X-Work"])) >= bits;

test("advised work goes out with the message", async () => {
  const { client, posts } = fake({ advise: { pow: { bits: 8, covers: 1 } } }, []);
  await client.send(W, "hello");
  assert.equal(posts().length, 1);
  assert.ok(reaches(posts()[0], 8));
});

test("an inbox without a gate gets no X-Work", async () => {
  const { client, posts } = fake({}, []);
  await client.send(W, "hello");
  assert.equal(posts()[0].headers["X-Work"], undefined);
});

test("a 428 is answered with the work, once", async () => {
  const { client, posts } = fake(null, [refusedWithGate(REQUIRE_8)]);
  await client.send(W, "hello");
  assert.equal(posts().length, 2);
  assert.equal(posts()[0].headers["X-Work"], undefined);
  assert.ok(reaches(posts()[1], 8));
});

test("never more than one more attempt", async () => {
  const { client, posts } = fake(null, [refusedWithGate(REQUIRE_8), refusedWithGate(REQUIRE_8), [201, { seq: 1 }]]);
  await assert.rejects(client.send(W, "hello"), (error) => error instanceof AamioError && error.status === 428);
  assert.equal(posts().length, 2);
});

test("work done and refused anyway is not done again", async () => {
  const { client, posts } = fake(REQUIRE_8, [refusedWithGate(REQUIRE_8)]);
  await assert.rejects(client.send(W, "hello"), (error) => error instanceof AamioError && error.status === 428);
  assert.equal(posts().length, 1);
});

test("a requirement the client cannot meet sends nothing", async () => {
  const { client, posts } = fake({ require: { toll: "any" } }, []);
  await assert.rejects(client.send(W, "hello"), GateStop);
  assert.equal(posts().length, 0);
});

test("advice this client passes over comes back in notes", async () => {
  const { client, posts } = fake({ advise: { pow: { bits: 4, covers: 1 }, fresh: 60 } }, []);
  const result = await client.send(W, "hello");
  assert.ok(reaches(posts()[0], 4));
  assert.ok(result.notes.some((note) => note.includes("fresh")));
});

test("the gate is read once per address", async () => {
  const { client, requests } = fake({ advise: { pow: { bits: 4, covers: 1 } } }, []);
  await client.send(W, "one");
  await client.send(W, "two");
  assert.equal(requests.filter((r) => r.url.endsWith("/gate")).length, 1);
});

// -------------------------------------------------------------------- board

import { Keys, boardAdvisedBits, boardPowDigest, boardPowInput, solveBoardWork } from "../src/aamio.js";

/** A client whose board is a fake: the descriptor given, an inbox opened on demand, posts recorded. */
function boardFake(descriptor) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.endsWith("/.well-known/aamio-board.json")) {
      return descriptor ? { status: 200, text: async () => JSON.stringify(descriptor) } : { status: 404, text: async () => JSON.stringify({ error: "no" }) };
    }
    if (init.method === "PUT") return { status: 201, text: async () => JSON.stringify({ expire_at: Math.floor(Date.now() / 1000) + 3600, allow: ["*"] }) };
    return { status: 201, text: async () => JSON.stringify({ id: "p1", work_bits: 4 }) };
  };
  const client = new Aamio({ fetch, keys: Keys.generate() });
  return { client, requests, posts: () => requests.filter((r) => r.method === "POST" && !r.url.endsWith("/find")), reads: () => requests.filter((r) => r.url.endsWith("/aamio-board.json")).length };
}

const boardReaches = (post, bits) => zeroBits(boardPowDigest(post.headers["X-Key"], sha256hex(post.body), post.headers["X-Work"])) >= bits;

test("the board input is its own string, and solveBoardWork reaches the bits", () => {
  assert.equal(boardPowInput("k", "h", "n"), "aamio-board-pow-v1\nk\nh\nn");
  assert.ok(!boardPowInput("k", "h", "n").includes("aamio-board-v1\n"));
  assert.ok(zeroBits(boardPowDigest(KEY, BODY_SHA256, solveBoardWork(KEY, BODY, 8))) >= 8);
});

test("the advised bits come from the descriptor and stop at the ceiling", () => {
  assert.equal(boardAdvisedBits({ work: { advise_bits: 16 } }), 16);
  assert.equal(boardAdvisedBits({ work: { advise_bits: 18 } }), 18);
  assert.equal(boardAdvisedBits({ work: { advise_bits: 19 } }), 0);
  assert.equal(boardAdvisedBits({ limits: {} }), 0);
  assert.equal(boardAdvisedBits(null), 0);
});

test("a post carries the work the board advises", async () => {
  const { client, posts } = boardFake({ work: { advise_bits: 4 } });
  await client.board.post({ kind: "need", title: "t", text: "x" });
  assert.equal(posts().length, 1);
  assert.ok(boardReaches(posts()[0], 4));
});

test("a board that advises nothing, or more than the ceiling, or cannot be read, gets no X-Work", async () => {
  for (const descriptor of [{ limits: {} }, { work: { advise_bits: 19 } }, null]) {
    const { client, posts } = boardFake(descriptor);
    await client.board.post({ kind: "need", title: "t", text: "x" });
    assert.equal(posts()[0].headers["X-Work"], undefined);
  }
});

test("the descriptor is read once", async () => {
  const { client, posts, reads } = boardFake({ work: { advise_bits: 4 } });
  await client.board.post({ kind: "need", title: "one", text: "x" });
  await client.board.post({ kind: "need", title: "two", text: "x" });
  assert.equal(posts().length, 2);
  assert.equal(reads(), 1);
});

test("the fix in a gate refusal names the host this client points at", () => {
  const fixOf = (base) => {
    try {
      gatePlan({ require: { toll: "any" } }, W, base);
    } catch (error) {
      return error instanceof GateStop ? error.fix : "";
    }
    return "";
  };
  assert.ok(fixOf("https://aamio.example/").includes(`GET https://aamio.example/${W}/gate`));
  assert.ok(fixOf(undefined).includes(`GET ${DEFAULT_BASE}/${W}/gate`));
});
