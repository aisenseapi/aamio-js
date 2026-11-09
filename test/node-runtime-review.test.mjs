// The review of 9 November of the Node runtime's first exchange (code/php/docs/aamio-node-utveksling-gjennomgang-2026-11-09.md):
// one test for each of its four findings and four deviations, against the fake aamio in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadSigningInput } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { serveMcp } from "../src/node-mcp.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";
const CANARY = "canaryscopekey00000000000000000000";

async function fixture(t, fake, ...names) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-review-"));
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

/** A save that fails with ENOSPC for this file, the first time or every time. */
function failSaving(runtime, file, times = 1) {
  const real = runtime.saveJson.bind(runtime);
  runtime.saveJson = async (name, value) => {
    if (name === file && times > 0) {
      times--;
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    return real(name, value);
  };
}

test("finding 1: names that differ only in case are never a guess, and a key given is the key the message is sealed to", async (t) => {
  const fake = new FakeAamio();
  const { s: homeS, one: homeOne, two: homeTwo, open } = await fixture(t, fake, "s", "one", "two");
  const sender = await open(homeS);
  const one = await open(homeOne);
  const two = await open(homeTwo);
  // An existing home with both, as an older client could leave it.
  sender.partnersFile = [{ name: "Ada", key: one.keys.public }, { name: "ADA", key: two.keys.public }];
  await sender.saveJson("partners.json", sender.partnersFile);
  for (const runtime of [one, two]) {
    await runtime.partnerAdd("s", sender.keys.public);
    await runtime.read();
  }
  for (const reverse of [false, true]) {
    fake.reverseLookup = reverse;
    await sender.send(two.keys.public, { text: `by key, ${reverse}` });
    await sender.send("ADA", { text: `by exact name, ${reverse}` });
    const atTwo = (await two.read()).map((m) => m.body.text);
    const atOne = await one.read();
    assert.deepEqual(atTwo, [`by key, ${reverse}`, `by exact name, ${reverse}`], "both reach the partner they were meant for");
    assert.deepEqual(atOne, [], "and nothing reaches the other");
  }
  await assert.rejects(sender.send("ada", { text: "a guess" }), { code: "ambiguous_partner" });
  await assert.rejects(one.partnerAdd("S", two.keys.public), { code: "ambiguous_partner" }, "a new name that differs only in case is refused");
});

test("finding 2: a scope share comes out of the message before the reader sees it, over the command line's runtime and over MCP", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  const b = await open(homeB);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await a.read();
  await b.send("a", { text: "a scope for you", data: { aamio_scope: { name: "review", key: CANARY } } });
  // And one with the field where it does not belong, sealed and signed by hand.
  const inbox = a.channel("inbox");
  const misplaced = b.keys.seal(a.keys.public, JSON.stringify({ text: "misplaced", aamio_scope: { name: "review", key: CANARY } }));
  await fake.fetch(`${HOST}/${inbox.w}`, { method: "POST", body: misplaced, headers: { "X-Key": b.keys.public, "X-Sig": b.keys.sign(threadSigningInput(inbox.w, misplaced)) } });
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  await serveMcp({ home: homeA, version: "test", runtime: a, input: Readable.from([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aamio_read", arguments: {} } }) + "\n"]), output });
  assert.ok(!text.includes(CANARY), "neither the structured result nor its text carries the key");
  const read = JSON.parse(text).result.structuredContent;
  assert.deepEqual(read.messages[0].body.data.aamio_scope, { shared_as: "review", can_read: true, kept: false, note: read.messages[0].body.data.aamio_scope.note });
  assert.match(read.messages[0].body.data.aamio_scope.note, /share it again/);
  assert.deepEqual(read.messages[1].body.aamio_scope, { kept: false, note: "not kept: a scope is shared in data.aamio_scope" });
  assert.ok(!(await readFile(join(homeA, "state.json"), "utf8")).includes(CANARY), "and the home keeps no copy of it");
});

test("finding 3: a read that cannot be written down hands nothing over, and the next read hands it over", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, c: homeC, open } = await fixture(t, fake, "a", "b", "c");
  const a = await open(homeA);
  const b = await open(homeB);
  const c = await open(homeC);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await c.partnerAdd("a", a.keys.public);
  await a.read();
  await b.send("a", { text: "one" });
  failSaving(a, "state.json");
  assert.deepEqual(await a.read(), [], "not handed over while it could not be written down");
  assert.ok(a.attentionTaken().some((note) => note.state === "not_saved"), "and said");
  assert.equal(a.channel("inbox").after, 0, "the cursor in memory is the one on disk");
  const [again] = await a.read();
  assert.equal(again.body.text, "one");
  assert.equal(again.replay, false, "the first time it is handed over is the first time");

  // Two channels: the old inbox saved, the new one not. What the first gave is handed over, and the second's waits.
  await b.send("a", { text: "on the old inbox" });
  await a.partnerAdd("c", c.keys.public);
  await c.send("a", { text: "on the new inbox" });
  let saves = 0;
  const real = a.saveJson.bind(a);
  a.saveJson = async (name, value) => {
    if (name === "state.json" && ++saves === 2) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return real(name, value);
  };
  const first = (await a.read()).map((m) => m.body.text);
  assert.equal(first.length, 1, "one channel's messages, written down, are handed over");
  const second = (await a.read()).map((m) => m.body.text);
  assert.deepEqual([...first, ...second].sort(), ["on the new inbox", "on the old inbox"], "and the other's come on the next read, none lost");
});

test("finding 4: a message the service stored is answered as delivered with its id, also when the outbox could not record it", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  let b = await open(homeB);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await a.read();
  // The outbox saves before the post and after it: the one after it fails.
  let saves = 0;
  const real = b.saveJson.bind(b);
  b.saveJson = async (name, value) => {
    if (name === "outbox.json" && ++saves === 3) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return real(name, value);
  };
  const sent = await b.send("a", { text: "stored once" });
  assert.match(sent.message_id, /^m-[0-9a-f]{16}$/);
  assert.equal(sent.seq, 1);
  assert.match(sent.outbox_error, /ENOSPC/);
  assert.match(sent.note, /Do not send this message again/);
  assert.equal(fake.requests.filter((r) => r.startsWith("POST /") && !r.startsWith("POST /p/")).length, 1, "one post, no more");
  await b.close();
  b = await open(homeB);
  const pending = b.outboxPending();
  assert.deepEqual(pending.map((p) => [p.message_id, p.status]), [[sent.message_id, "unknown"]], "after a restart the unrecorded delivery is unknown, never unsent");
  assert.equal((await a.read()).length, 1);
});

test("deviation 1: a file of the home that is not UTF-8 stops the runtime, and its bytes stay as they were", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA } = await fixture(t, fake, "a");
  const broken = Buffer.from('[{"name":"caf\xe9","key":"A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"}]', "latin1");
  for (const file of ["partners.json", "state.json", "outbox.json"]) {
    await writeFile(join(homeA, file), broken);
    await assert.rejects(NodeRuntime.open({ home: homeA, host: HOST, fetch: fake.fetch }), { code: "state_unreadable" }, file);
    assert.deepEqual(await readFile(join(homeA, file)), broken, `${file} is left byte for byte`);
    await rm(join(homeA, file));
  }
});

test("deviation 2: an outbox left by a process that stopped is settled as aamio-python settles it", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA } = await fixture(t, fake, "a");
  const base = { w: "abcdefghijklmnopqrst", to_key: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg", envelope: "{}", attempts: 1, created_at: 1 };
  await writeFile(join(homeA, "outbox.json"), JSON.stringify({
    "m-0000000000000001": { ...base, id: "m-0000000000000001", status: "sending" },
    "m-0000000000000002": { ...base, id: "m-0000000000000002", status: "working", attempts: 0 },
    "m-0000000000000003": { ...base, id: "m-0000000000000003", status: "working", posting: true },
  }));
  const a = await NodeRuntime.open({ home: homeA, host: HOST, fetch: fake.fetch });
  try {
    assert.deepEqual(Object.values(a.outbox).map((e) => e.status), ["unknown", "stopped", "unknown"]);
    assert.deepEqual(a.outboxPending().map((p) => p.message_id), ["m-0000000000000001", "m-0000000000000003"]);
    const said = a.attentionTaken().map((note) => note.state);
    assert.deepEqual(said.sort(), ["stopped", "unknown", "unknown"], "each is said once");
  } finally {
    await a.close();
  }
  const again = await NodeRuntime.open({ home: homeA, host: HOST, fetch: fake.fetch });
  try {
    assert.deepEqual(again.attentionTaken(), [], "and not again after the next start");
  } finally {
    await again.close();
  }
});

test("deviation 3: a message on an older inbox that is still read comes at once, before any wait", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, c: homeC, open } = await fixture(t, fake, "a", "b", "c");
  const a = await open(homeA);
  const b = await open(homeB);
  const c = await open(homeC);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await a.read();
  await b.send("a", { text: "on the old inbox" });
  await a.partnerAdd("c", c.keys.public);
  fake.requests = [];
  const got = await a.read({ wait: 5 });
  assert.deepEqual(got.map((m) => m.body.text), ["on the old inbox"]);
  assert.ok(!fake.requests.some((r) => r.includes("/wait/")), "nothing waited: the message was there");
});

test("deviation 4: a send refreshes presence, so the partner finds the sender to answer after the record ran out", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  const b = await open(homeB);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await a.read();
  await b.read();
  fake.time += 140;
  await a.read();
  await b.send("a", { text: "after two minutes" });
  const found = await a.lookup(["b"]);
  assert.deepEqual(found.online.map((o) => o.name), ["b"], "b's send published b again");
});
