// The follow-up review of 9 November of the Node runtime, after 22177be (code/php/docs/aamio-node-utveksling-gjennomgang-2026-11-09.md):
// one test for each of its two findings and five further cases, against the fake aamio in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyHash } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { FakeAamio } from "./fake-aamio.mjs";

const HOST = "https://fake.aamio";
const ENOSPC = () => Object.assign(new Error("no space left on device"), { code: "ENOSPC" });

// Homes in a folder of their own. fetch is read when a home is opened, so a test can put its own in front of the fake's.
async function fixture(t, fake, ...names) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-followup-"));
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
    const runtime = await NodeRuntime.open({ home, host: HOST, fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time });
    opened.push(runtime);
    return runtime;
  };
  const close = async (runtime) => {
    await runtime.close();
    opened.splice(opened.indexOf(runtime), 1);
  };
  return { ...made, open, close };
}

/** Saves of this file fail with ENOSPC while the test says so. */
function failSaving(runtime, file) {
  const real = runtime.saveJson.bind(runtime);
  const control = { failing: true, count: 0 };
  runtime.saveJson = async (name, value) => {
    if (name === file) {
      control.count++;
      if (typeof control.failing === "function" ? control.failing(control.count) : control.failing) throw ENOSPC();
    }
    return real(name, value);
  };
  return control;
}

const onDisk = async (home, file) => JSON.parse(await readFile(join(home, file), "utf8"));
const presenceOf = (fake, runtime) => [...fake.presence.values()].filter((record) => JSON.stringify(record).includes(keyHash(runtime.keys.public).slice(0, 8)));

test("finding 1: an inbox that state.json does not hold is never used, published or given as reply_to", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  const b = await open(homeB);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  const disk = failSaving(a, "state.json");
  await assert.rejects(a.read(), { code: "inbox_unavailable" }, "the first inbox cannot be written down");
  await assert.rejects(a.read(), { code: "inbox_unavailable" }, "and the next read does not take the unsaved one");
  assert.equal(a.channel("inbox"), null, "nothing is kept in memory that the file does not hold");
  assert.deepEqual(presenceOf(fake, a), [], "and nothing is published");
  assert.ok((await a.attentionTaken()).some((note) => note.state === "rotation_failed"));
  await assert.rejects(b.send("a", { text: "to nowhere" }), { code: "partner_offline" }, "b finds no address of a's");

  disk.failing = false;
  assert.deepEqual(await a.read(), []);
  const inbox = a.channel("inbox");
  assert.equal((await onDisk(homeA, "state.json")).channels.find((c) => c.label === "inbox").read_key, inbox.read_key, "the inbox used is the inbox written");

  // An inbox that has to open again for a new partner, with the disk full: the old one stays, as the file has it.
  const { c: homeC, open: openC } = await fixture(t, fake, "c");
  const c = await openC(homeC);
  disk.failing = true;
  const added = await a.partnerAdd("c", c.keys.public);
  assert.equal(added.rotated, false);
  assert.match(added.error, /could not be written down/);
  assert.deepEqual(a.state.channels.map((ch) => [ch.label, ch.w, ch.muted]), [["inbox", inbox.w, false]], "the old inbox keeps its label");
  disk.failing = false;
  await a.read();
  const labels = (await onDisk(homeA, "state.json")).channels.map((ch) => ch.label);
  assert.equal(labels.filter((label) => label === "inbox").length, 1);
  assert.deepEqual(a.channel("inbox").allow.sort(), [b.keys.public, c.keys.public].sort(), "and the next read opens the inbox for both");
});

test("finding 2: a folder that cannot be synced after the rename does not hide a message the cursor on disk has passed", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open, close } = await fixture(t, fake, "a", "b");
  let a = await open(homeA);
  const b = await open(homeB);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await a.read();
  await b.send("a", { text: "once" });
  a.syncFolder = async () => {
    throw Object.assign(new Error("input/output error"), { code: "EIO" });
  };
  const got = await a.read();
  assert.deepEqual(got.map((m) => m.body.text), ["once"], "the message the file now says was read is handed over");
  // Once for each file the read wrote: the cursor's, and the trace of what it handed over.
  const notes = (await a.attentionTaken()).filter((note) => note.state === "not_synced");
  assert.deepEqual(notes.map((note) => note.what.split(" ")[0]).sort(), ["state.json", "trace.json"], "and the uncertain sync is said, once for each file");
  assert.match(notes.find((note) => note.what.startsWith("state.json")).what, /state\.json was replaced.*what was read since would then be read again/);
  assert.doesNotMatch(notes.find((note) => note.what.startsWith("trace.json")).what, /read again/, "what is true of the cursor's file is not said of another");
  assert.equal((await onDisk(homeA, "state.json")).channels.find((c) => c.label === "inbox").after, a.channel("inbox").after, "memory and disk agree");
  await close(a);
  a = await open(homeA);
  assert.deepEqual(await a.read(), [], "after a restart nothing is read again, and nothing was passed over unread");
});

test("case a: a send the outbox cannot record says its id, and one recorded but never handed on is stopped after a restart", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open, close } = await fixture(t, fake, "a", "b");
  const a = await open(homeA);
  let b = await open(homeB);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await a.read();
  // Writes to a thread: presence lookups are posts too, to /p/lookup.
  const posts = () => fake.requests.filter((r) => r.startsWith("POST /") && !r.startsWith("POST /p/")).length;
  const before = posts();

  const first = failSaving(b, "outbox.json");
  const unrecorded = await b.send("a", { text: "first write fails" }).catch((error) => error);
  assert.equal(unrecorded.code, "not_sent");
  assert.match(unrecorded.message_id, /^m-[0-9a-f]{16}$/, "with the message's id");
  assert.equal(unrecorded.outcome, "stopped");
  assert.equal(b.outbox[unrecorded.message_id], undefined, "and nothing of it in the outbox");

  // The entry is written, and the write that hands it on, attempts 1, fails.
  first.count = 0;
  first.failing = (count) => count === 2;
  const unsent = await b.send("a", { text: "second write fails" }).catch((error) => error);
  assert.equal(unsent.code, "not_sent");
  assert.equal(unsent.outcome, "stopped");
  assert.equal((await onDisk(homeB, "outbox.json"))[unsent.message_id].attempts, 0, "the file holds it as recorded and never handed on");
  assert.equal(posts(), before, "neither left this machine");

  await close(b);
  b = await open(homeB);
  assert.equal(b.outbox[unsent.message_id].status, "stopped", "a restart calls it stopped, never unknown");
  assert.deepEqual(b.outboxPending(), []);
  const said = (await b.attentionTaken()).find((note) => note.channel === `send ${unsent.message_id}`);
  assert.match(said.what, /was not sent/);
});

test("case b: what a stopped process left is told when it is handed to someone, not when the home is opened", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, open, close } = await fixture(t, fake, "a");
  const base = { w: "abcdefghijklmnopqrst", to_key: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg", envelope: "{}", created_at: 1 };
  await writeFile(join(homeA, "outbox.json"), JSON.stringify({ "m-0000000000000001": { ...base, id: "m-0000000000000001", status: "working", attempts: 0 } }));
  let a = await open(homeA);
  // A command that shows no notes, partner list here, and the process ends.
  a.partnerList();
  await close(a);
  a = await open(homeA);
  const said = await a.attentionTaken();
  assert.deepEqual(said.map((note) => note.state), ["stopped"], "said on the next start, since nobody was told");
  await close(a);
  a = await open(homeA);
  assert.deepEqual(await a.attentionTaken(), [], "and once told, not again");
});

test("case c: a message that reaches an older inbox during the wait on the new one comes with the same read", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, c: homeC, open } = await fixture(t, fake, "a", "b", "c");
  const real = fake.fetch;
  let during = null;
  fake.fetch = async (url, init = {}) => {
    if (during && (init.method || "GET") === "GET" && String(url).includes("/wait/")) {
      const now = during;
      during = null;
      await now();
    }
    return real(url, init);
  };
  const a = await open(homeA);
  const b = await open(homeB);
  const c = await open(homeC);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await a.read();
  const older = a.channel("inbox").w;
  await a.partnerAdd("c", c.keys.public);
  assert.notEqual(a.channel("inbox").w, older, "a new inbox for b and c, and the older one still read for b");
  during = () => b.client.send(older, { text: "during the wait" }, { encryptTo: a.keys.public });
  const got = await a.read({ wait: 2 });
  assert.equal(during, null, "the read waited on the new inbox");
  assert.deepEqual(got.map((m) => [m.body.text, m.sender]), [["during the wait", "b"]], "and what came meanwhile is in its answer");
});

test("case d: a 201 that carries no receipt is a delivery, said as one with the message's id", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const real = fake.fetch;
  let empty = false;
  fake.fetch = async (url, init = {}) => {
    const answer = await real(url, init);
    return empty && init.method === "POST" && answer.status === 201 ? new Response("", { status: 201 }) : answer;
  };
  const a = await open(homeA);
  const b = await open(homeB);
  await a.partnerAdd("b", b.keys.public);
  await b.partnerAdd("a", a.keys.public);
  await a.read();
  empty = true;
  const sent = await b.send("a", { text: "stored, no receipt" });
  assert.equal(b.outbox[sent.message_id].status, "delivered");
  assert.equal(sent.seq, null);
  assert.equal(sent.sha256, null);
  assert.match(sent.note, /Delivered: aamio answered 201/);
  assert.match(sent.note, /Do not send this message again/);
  assert.deepEqual((await a.read()).map((m) => m.body.text), ["stored, no receipt"]);
});

test("case e: a lookup by name chooses as a send does, and answers only for the partners asked for", async (t) => {
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
    const found = await sender.lookup(["ADA"]);
    assert.deepEqual(found.online.map((o) => [o.name, o.key]), [["ADA", two.keys.public]], `only ADA, with presence ${reverse ? "the other way round" : "in order"}`);
    assert.deepEqual(found.offline, []);
  }
  await assert.rejects(sender.lookup(["ada"]), { code: "ambiguous_partner" }, "a name that is both apart from case is an error, never two answers");
  const some = await sender.lookup(["nobody", "Ada", "Ada"]);
  assert.deepEqual(some.online.map((o) => o.name), ["Ada"], "a name given twice is looked up once");
  assert.deepEqual(some.unknown, ["nobody"], "and a name that is nobody's is said");
  assert.deepEqual((await sender.lookup()).online.map((o) => o.name).sort(), ["ADA", "Ada"], "without names, everyone");
});
