// The Node runtime against a fake aamio in memory: an exchange between two homes, what a home opened again keeps,
// the outcomes a send can have, files that cannot be read, the inbox following the address book, and a message
// the inbox's list keeps out. The same exchange through the real service, and with aamio-python, is
// code/php/tools/check-node-exchange.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keys, threadSigningInput } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";

// Homes in a folder of their own, and the runtimes opened in them: closed before the folder goes, since
// on Windows a held owner.lock cannot be removed.
async function fixture(t, fake, ...names) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-runtime-"));
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
    const runtime = await NodeRuntime.open({ home, host: HOST, fetch: fake.fetch, clock: () => fake.time });
    opened.push(runtime);
    return runtime;
  };
  return { ...made, open };
}

test("two homes exchange a sealed message, and a home opened again keeps its identity, its cursor and its hashes", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  let a = await open(homeA);
  const b = await open(homeB);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  assert.deepEqual(await a.read(), []);
  const inbox = a.channel("inbox");
  assert.deepEqual(inbox.allow, [b.keys.public], "an inbox only the partner may write to");

  const sent = await b.send("a", { text: "hello from b" });
  assert.equal(sent.to, "a");
  assert.equal(sent.w, inbox.w);
  const [got, ...more] = await a.read();
  assert.equal(more.length, 0);
  assert.equal(got.sender, "b");
  assert.equal(got.verified, true);
  assert.equal(got.encrypted, true);
  assert.equal(got.body.text, "hello from b");
  assert.equal(got.body.reply_to, b.channel("inbox").w, "the sender's inbox rides along to answer at");
  assert.equal(got.sha256, sent.sha256);
  assert.equal(got.replay, false);
  const entry = b.outbox[sent.message_id];
  assert.equal(entry.status, "delivered");
  assert.equal(entry.attempts, 1);
  assert.deepEqual(b.outboxPending(), []);
  assert.equal(a.state.peers[got.body.reply_to], b.keys.public, "a verified reply_to binds the sender's key to it");

  const key = a.keys.public;
  await a.close();
  a = await open(homeA);
  assert.equal(a.keys.public, key);
  assert.deepEqual(await a.read(), [], "the cursor was saved before the message was handed over");
  a.channel("inbox").after = 0;
  const [again] = await a.read();
  assert.equal(again.sha256, sent.sha256);
  assert.equal(again.replay, true, "the hashes outlive the process");

  const answer = await a.send("b", { text: "answer", re: sent.sha256 });
  const [back] = await b.read();
  assert.equal(back.sender, "a");
  assert.equal(back.body.re, sent.sha256);
  assert.equal(back.sha256, answer.sha256);
});

test("a send with no answer is unknown and pending, and one the service refuses is refused and settled", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  const b = await open(homeB);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await a.read();
  fake.failNext("network");
  await assert.rejects(b.send("a", { text: "into the void" }), (error) => error.code === "send_failed" && error.outcome === "unknown");
  const pending = b.outboxPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "unknown");
  fake.failNext(422);
  await assert.rejects(b.send("a", { text: "refused" }), (error) => error.outcome === "refused" && error.status === 422);
  assert.equal(b.outboxPending().length, 1, "a refusal is settled and not pending");
  const saved = JSON.parse(await readFile(join(homeB, "outbox.json"), "utf8"));
  assert.deepEqual(Object.values(saved).map((e) => e.status).sort(), ["refused", "unknown"], "and both are in the file as they are in memory");
});

test("a file of the home that cannot be read stops the runtime before anything is saved over it", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA } = await fixture(t, fake, "a");
  await writeFile(join(homeA, "partners.json"), "{not json");
  await assert.rejects(NodeRuntime.open({ home: homeA, host: HOST, fetch: fake.fetch }), { code: "state_unreadable" });
  assert.equal(await readFile(join(homeA, "partners.json"), "utf8"), "{not json", "the file is left as it was");
  await writeFile(join(homeA, "partners.json"), "[]");
  const a = await NodeRuntime.open({ home: homeA, host: HOST, fetch: fake.fetch });
  await a.close();
});

test("the inbox follows the address book: a partner added opens one that names the key, and the old one is still read", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, c: homeC, open } = await fixture(t, fake, "a", "b", "c");
  const a = await open(homeA);
  const b = await open(homeB);
  const c = await open(homeC);
  await a.partnerAdd("b", b.keys.public);
  await a.read();
  const first = a.channel("inbox").w;
  const added = await a.partnerAdd("c", c.keys.public);
  assert.equal(added.rotated, true);
  assert.deepEqual([...a.channel("inbox").allow].sort(), [b.keys.public, c.keys.public].sort());
  const old = a.state.channels.find((channel) => channel.w === first);
  assert.match(old.label, /^inbox-\d+$/);
  assert.equal(old.muted, false, "nobody was removed, so whoever has the old address is still read there");
  assert.equal(added.presence, true, "and the new address is published at once");
});

test("what the inbox's list does not allow is kept out and said, after the service lost the list", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  const b = await open(homeB);
  await a.partnerAdd("b", b.keys.public);
  await a.read();
  const inbox = a.channel("inbox");
  // The store was emptied: a write opens a thread with no list, and a stranger's message is taken.
  fake.forget(inbox.w);
  const stranger = Keys.generate();
  const body = JSON.stringify({ text: "from a stranger" });
  await fake.fetch(`${HOST}/${inbox.w}`, { method: "POST", body, headers: { "X-Key": stranger.public, "X-Sig": stranger.sign(threadSigningInput(inbox.w, body)) } });
  fake.threads.get(inbox.w).id = inbox.read_key;
  assert.deepEqual(await a.read(), [], "not handed over");
  const said = a.attentionTaken().find((note) => note.state === "kept_out");
  assert.ok(said, "and said, never dropped in silence");
  assert.equal(a.channel("inbox").after, 1, "the cursor moves past it, or it is kept out again on every read");
});

test("over MCP a server that holds the home offers its tools, and a message goes from one to the other", async (t) => {
  const { PassThrough, Readable } = await import("node:stream");
  const { serveMcp } = await import("../src/node-mcp.js");
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  const b = await open(homeB);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  const call = async (runtime, name, args) => {
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += chunk; });
    const request = { jsonrpc: "2.0", id: 1, method: name === "tools/list" ? name : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } };
    await serveMcp({ home: runtime.home, version: "test", runtime, input: Readable.from([JSON.stringify(request) + "\n"]), output });
    return JSON.parse(text.trim());
  };
  const list = await call(a, "tools/list");
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["aamio_whoami", "aamio_partners", "aamio_partner_add", "aamio_presence_lookup", "aamio_send", "aamio_read", "aamio_pending"]);
  assert.equal((await call(a, "aamio_read", {})).result.isError, false, "the first read opens the inbox and publishes it");
  const sent = await call(b, "aamio_send", { to: "a", text: "over mcp" });
  assert.equal(sent.result.isError, false, JSON.stringify(sent));
  const read = (await call(a, "aamio_read", { wait: 0 })).result.structuredContent;
  assert.equal(read.count, 1);
  assert.equal(read.messages[0].body.text, "over mcp");
  assert.equal(read.messages[0].sender, "b");
  assert.equal(read.messages[0].sha256, sent.result.structuredContent.sha256);
  assert.equal((await call(a, "aamio_send", { text: "no recipient" })).error.code, -32602, "arguments the schema does not allow are refused before anything is done");
  const failed = (await call(b, "aamio_send", { to: "nobody", text: "x" })).result;
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error_code, "unknown_partner");
  assert.deepEqual((await call(b, "aamio_partners", {})).result.structuredContent.partners.map((p) => p.name), ["a"]);
  assert.deepEqual((await call(b, "aamio_pending", {})).result.structuredContent.pending, []);
});
