// The open board from the Node runtime, against the fake aamio and its board in memory: a post that points at a
// board inbox, a stranger who finds it and answers through the outbox, the answer read with the other messages and
// answered back, withdrawal, a board that is down, and a board inbox that is used only once it is written down.
// The same round through the real service is in code/php/tools/check-node-exchange.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initIdentity } from "../src/node-identity.js";
import { ANSWER_MARGIN, NodeRuntime } from "../src/node-runtime.js";
import { BOARD, FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";

async function fixture(t, fake, ...names) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-board-"));
  const opened = [];
  t.after(async () => {
    for (const runtime of opened) await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const made = {};
  for (const name of names) {
    made[name] = join(root, name);
    await initIdentity(made[name]);
  }
  const open = async (home) => {
    const runtime = await NodeRuntime.open({ home, host: HOST, board: BOARD, fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time });
    opened.push(runtime);
    return runtime;
  };
  return { ...made, open };
}

const onDisk = async (home) => JSON.parse(await readFile(join(home, "state.json"), "utf8"));

test("a post points at a board inbox, a stranger finds it and answers, and the two go on talking", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  const b = await open(homeB);

  const posted = await a.boardPost({ kind: "need", title: "cold chain check", text: "Who can check a reefer log tonight?", tags: ["coldchain.qa"], ttl: 1200, lang: "en" });
  const board = a.channel("board");
  assert.equal(posted.inbox, board.w);
  assert.equal(posted.post.w, board.w, "the post points at the board inbox");
  assert.deepEqual(board.allow, ["*"], "which takes any signed key, since whoever answers has not been met");
  assert.ok(board.expire_at >= fake.time + 1200, "and outlives the post");
  assert.equal((await onDisk(homeA)).channels.find((c) => c.label === "board").read_key, board.read_key, "written down before the post went out");
  assert.match(posted.read_them_with, /aamio_read/);
  assert.equal(posted.post.expire_at, fake.time + 1200, "a post well inside its inbox keeps the lifetime it asked for");
  // The fields aamio-python and aamio-php answer with, in their order, and until when the inbox is open.
  assert.deepEqual(Object.keys(posted), ["post", "inbox", "inbox_expires_at", "answers_arrive_on", "read_them_with"]);
  assert.equal(posted.inbox_expires_at, board.expire_at);
  assert.ok(posted.inbox_expires_at >= posted.post.expire_at, "the inbox outlives the post");
  assert.ok("inbox_expires_at" in a.whoami(), "the name whoami gives the inbox's time");

  const found = await b.boardFind({ tags: ["coldchain"], kind: "need" });
  assert.deepEqual(found.posts.map((p) => p.id), [posted.post.id], "a tag covers its dotted children");
  assert.equal(b.state.peers[board.w], a.keys.public, "the address on a post is bound to the key that signed it");
  assert.deepEqual((await b.boardTags()).tags, [{ tag: "coldchain.qa", needs: 1, offers: 0 }]);

  const answered = await b.boardAnswer(posted.post.id, { text: "I can, at 21:00", data: { price: 0 } });
  assert.equal(answered.post, posted.post.id);
  assert.equal(answered.reply_to, b.channel("board").w, "the answer carries b's board inbox to write back to");
  assert.equal(b.outbox[answered.message_id].status, "delivered", "and went through the outbox");
  assert.ok(b.channel("board").expire_at >= posted.post.expire_at + ANSWER_MARGIN - 60, "b's address outlives the post it answers");

  const [got, ...more] = await a.read();
  assert.equal(more.length, 0);
  assert.equal(got.channel, "board");
  assert.equal(got.sender, "unknown key", "a stranger, signed and checked here");
  assert.equal(got.verified, true);
  assert.equal(got.encrypted, true);
  assert.deepEqual([got.body.post, got.body.text, got.body.data], [posted.post.id, "I can, at 21:00", { price: 0 }]);

  // Back to the address the verified answer gave, sealed to the key that signed it.
  const back = await a.send(got.body.reply_to, { text: "Thanks, see you then", re: got.sha256 });
  assert.equal(back.w, b.channel("board").w);
  const [reply] = await b.read();
  assert.deepEqual([reply.channel, reply.body.text, reply.body.re, reply.from_key], ["board", "Thanks, see you then", got.sha256, a.keys.public]);
});

test("a withdrawn post is gone for everyone, and an answer to it is refused before anything is sent", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  const b = await open(homeB);
  const { post } = await a.boardPost({ kind: "offer", title: "spare GPU hours", text: "Two hours tonight." });
  assert.deepEqual(await a.boardWithdraw(post.id), { id: post.id, deleted: true }, "the board's own answer");
  assert.deepEqual((await b.boardFind({})).posts, []);
  assert.equal(await b.boardGet(post.id), null);
  const before = Object.keys(b.outbox).length;
  await assert.rejects(b.boardAnswer(post.id, { text: "too late" }), { code: "unknown_post" });
  assert.equal(Object.keys(b.outbox).length, before, "nothing went into the outbox");
  await assert.rejects(b.boardWithdraw(post.id), { code: "board_failed", status: 404 });
});

test("a board that is down is not a post that is gone, and its refusals carry its fix", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, open } = await fixture(t, fake, "a");
  const real = fake.fetch;
  let down = false;
  fake.fetch = async (url, init = {}) => (down && String(url).startsWith(BOARD) ? new Response(JSON.stringify({ error: "the store could not be opened" }), { status: 503 }) : real(url, init));
  const a = await open(homeA);
  const { post } = await a.boardPost({ kind: "need", title: "x", text: "y" });
  down = true;
  await assert.rejects(a.boardGet(post.id), (error) => error.code === "board_failed" && /whether that post is live is unknown/.test(error.message));
  await assert.rejects(a.boardAnswer(post.id, { text: "hi" }), { code: "board_failed" });
  down = false;
  await assert.rejects(a.boardPost({ kind: "maybe", title: "x", text: "y" }), (error) => error.code === "board_failed" && error.status === 400 && error.fix === "Say need or offer.");
});

test("one board inbox serves the posts while it lasts, and one that is replaced is still read", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  const b = await open(homeB);
  const first = await a.boardPost({ kind: "need", title: "one", text: "first", ttl: 600 });
  const second = await a.boardPost({ kind: "need", title: "two", text: "second", ttl: 600 });
  assert.equal(second.inbox, first.inbox, "the same inbox, while it lasts");
  await b.boardAnswer(first.post.id, { text: "to the first" });
  // The inbox lives 900 s. After 400 a post of 600 would outlive it, while it still takes answers for 500.
  fake.time += 400;
  const third = await a.boardPost({ kind: "need", title: "three", text: "third", ttl: 600 });
  assert.notEqual(third.inbox, first.inbox, "a post that would outlive it gets a new one");
  const older = a.state.channels.find((c) => c.w === first.inbox);
  assert.match(older.label, /^board-\d+$/, "the older one keeps its records under a label of its own");
  const got = await a.read();
  assert.deepEqual(got.map((m) => [m.channel, m.body.text]), [[older.label, "to the first"]], "and is still read until it expires");
});

test("a board inbox that cannot be written down is never put on a post", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, open } = await fixture(t, fake, "a");
  const a = await open(homeA);
  const real = a.saveJson.bind(a);
  a.saveJson = async (name, value) => {
    if (name === "state.json") throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return real(name, value);
  };
  await assert.rejects(a.boardPost({ kind: "need", title: "x", text: "y" }), { code: "not_saved" });
  assert.equal(a.channel("board"), null);
  assert.equal(fake.posts.size, 0, "nothing was posted");
});

test("an answer to your own post says it reaches nobody but you", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, open } = await fixture(t, fake, "a");
  const a = await open(homeA);
  const { post } = await a.boardPost({ kind: "offer", title: "x", text: "y" });
  const answered = await a.boardAnswer(post.id, { text: "to myself" });
  assert.match(answered.warning, /sealed to your own key/);
});

test("over MCP the board tools post, find, answer, list tags and withdraw, and refuse what their schemas do not allow", async (t) => {
  const { PassThrough, Readable } = await import("node:stream");
  const { serveMcp } = await import("../src/node-mcp.js");
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  const b = await open(homeB);
  const call = async (runtime, name, args) => {
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += chunk; });
    const request = { jsonrpc: "2.0", id: 1, method: name === "tools/list" ? name : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } };
    await serveMcp({ home: runtime.home, version: "test", runtime, input: Readable.from([JSON.stringify(request) + "\n"]), output });
    return JSON.parse(text.trim());
  };
  const names = (await call(a, "tools/list")).result.tools.map((tool) => tool.name);
  for (const tool of ["aamio_board_post", "aamio_board_find", "aamio_board_answer", "aamio_board_withdraw", "aamio_board_tags"]) assert.ok(names.includes(tool), tool);

  const posted = (await call(a, "aamio_board_post", { kind: "offer", title: "translation", text: "Norwegian to English, today.", tags: ["lang.no"] })).result;
  assert.equal(posted.isError, false, JSON.stringify(posted));
  const id = posted.structuredContent.post.id;
  const found = (await call(b, "aamio_board_find", { tags: ["lang"] })).result.structuredContent;
  assert.deepEqual(found.posts.map((p) => p.id), [id]);
  const answered = (await call(b, "aamio_board_answer", { post: id, text: "Yes please", data: { words: 300 } })).result;
  assert.equal(answered.isError, false, JSON.stringify(answered));
  const read = (await call(a, "aamio_read", {})).result.structuredContent;
  assert.deepEqual(read.messages.map((m) => [m.channel, m.body.text, m.body.post]), [["board", "Yes please", id]]);
  assert.deepEqual((await call(b, "aamio_board_tags", {})).result.structuredContent.tags, [{ tag: "lang.no", needs: 0, offers: 1 }]);
  assert.equal((await call(a, "aamio_board_withdraw", { post: id })).result.isError, false);

  const gone = (await call(b, "aamio_board_answer", { post: id, text: "still there?" })).result;
  assert.equal(gone.isError, true);
  assert.equal(gone.structuredContent.error_code, "unknown_post");
  for (const [args, why] of [[{ kind: "maybe", title: "x", text: "y" }, "kind is need or offer"], [{ kind: "need", title: "x", text: "y", tags: Array(9).fill("t") }, "at most eight tags"], [{ kind: "need", title: "x".repeat(81), text: "y" }, "a title of at most 80"]]) {
    const refused = (await call(a, "aamio_board_post", args)).result;
    assert.deepEqual([refused?.isError, refused?.structuredContent?.error_code], [true, "invalid_arguments"], why);
  }
  assert.equal(fake.posts.size, 0, "nothing refused by the schema reached the board");
});

test("a post asked for as long as an inbox lives leaves the inbox room for the work and the round trip", async (t) => {
  // The library counts the inbox's time on the machine's clock, so the stand-in keeps the machine's time.
  const fake = new FakeAamio({ now: Math.floor(Date.now() / 1000) });
  const { a: homeA, open } = await fixture(t, fake, "a");
  const a = await open(homeA);
  const posted = await a.boardPost({ kind: "need", title: "a whole hour", text: "as long as it may", ttl: 3600 });
  const inbox = a.channel("board");
  assert.equal(inbox.expire_at, fake.time + 3600, "the inbox lives the hour, and no longer");
  const life = posted.post.expire_at - fake.time;
  assert.ok(life >= 3600 - 32 && life <= 3600 - 30, `the post gives way by the margin, not the promise: ${life}`);
  assert.ok(posted.inbox_expires_at - posted.post.expire_at >= 30);
});
