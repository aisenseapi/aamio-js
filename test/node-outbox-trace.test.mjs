// Stage 2 of the Node plan (code/php/docs/aamio-node-funksjonsplan-2026-11-10.md): the outbox's retry and forget, and
// the conversation trace, against the fake aamio in memory. The files are the ones aamio-python and aamio-php keep:
// the same over the real service, with those two runtimes on the same home, is in code/php/tools/check-node-exchange.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Aamio, GateStop, Keys, sha256hex, threadSigningInput } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { serveMcp } from "../src/node-mcp.js";
import { NodeRuntime, OUTBOX_NOTES, outboxOpen, outboxOutcome, outboxRetryable, sendAdvice, stopFields } from "../src/node-runtime.js";
import { TRACE_FIELDS, TRACE_FIELD_CHARS, TRACE_KEEP, TRACE_KEYS, normalizeTraces, traceView } from "../src/node-trace.js";
import { BOARD, FakeAamio } from "./fake-aamio.mjs";
import { serveFake } from "./serve-fake.mjs";

const HOST = "https://fake.aamio";
const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));

async function fixture(t, fake, ...names) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-stage2-"));
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
  return { ...made, root, open };
}

/** Two homes that are each other's partners, each with its inbox open. */
async function pair(t, fake) {
  const { a: homeA, b: homeB, open, root } = await fixture(t, fake, "a", "b");
  const receiver = await open(homeA);
  const sender = await open(homeB);
  await receiver.partnerAdd("sender", sender.keys.public);
  await sender.partnerAdd("receiver", receiver.keys.public);
  await receiver.read();
  await sender.read();
  return { receiver, sender, homeA, homeB, open, root };
}

/** Saves of this file fail with ENOSPC, this many times. */
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

const onDisk = async (home, file) => JSON.parse(await readFile(join(home, file), "utf8"));
const posts = (fake) => fake.requests.filter((line) => line.startsWith("POST /") && !line.startsWith("POST /p/")).length;
const bodies = (fake, w) => fake.threads.get(w).messages.map((m) => m.body);

/** A send that is stored while its answer is lost: the error a caller gets, with the id to settle it by. */
async function lostSend(fake, sender, text = "stored, and the answer lost") {
  fake.failNext("lost");
  let failure = null;
  try {
    await sender.send("receiver", { text });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "send_failed");
  return failure;
}

async function call(runtime, name, args) {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const request = { jsonrpc: "2.0", id: 1, method: name === "tools/list" ? name : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } };
  await serveMcp({ home: runtime.home, version: "test", runtime, input: Readable.from([JSON.stringify(request) + "\n"]), output });
  return JSON.parse(text.trim());
}

// ------------------------------------------------------------------ the outbox

test("a send stored whose answer was lost is unknown, and a retry sends the same id and the same bytes, which the reader marks a replay", async (t) => {
  const fake = new FakeAamio();
  const { receiver, sender } = await pair(t, fake);
  const failure = await lostSend(fake, sender);
  assert.equal(failure.outcome, "unknown");
  assert.equal(failure.status, 0);
  assert.equal(failure.retryable, null, "whether it is stored cannot be told from here");
  assert.match(failure.fix, /aamio_outbox_retry with this id, or aamio outbox retry --id/);
  const id = failure.message_id;
  const entry = sender.outbox[id];
  const { envelope, w } = entry;
  assert.equal(bodies(fake, w).length, 1, "the service stored it");
  assert.deepEqual(sender.outboxPending().map((p) => [p.message_id, p.status]), [[id, "unknown"]]);

  const retried = await sender.outboxRetry(id);
  assert.deepEqual(retried, [{ id, w, status: "delivered", http: 201 }]);
  assert.deepEqual(bodies(fake, w), [envelope, envelope], "the same bytes, to the same address");
  assert.equal(sender.outbox[id].envelope, envelope);
  assert.equal(sender.outbox[id].attempts, 2);
  assert.equal(Object.keys(sender.outbox).length, 1, "one message, one entry");
  assert.deepEqual(sender.outboxPending(), []);
  assert.deepEqual((await receiver.read()).map((m) => [m.seq, m.replay, m.body.text]), [[1, false, "stored, and the answer lost"], [2, true, "stored, and the answer lost"]]);

  // Delivered: nothing goes out for it again.
  const before = posts(fake);
  assert.deepEqual(await sender.outboxRetry(id), []);
  assert.deepEqual(await sender.outboxRetry(), []);
  assert.equal(posts(fake), before);
});

test("a retry survives a restart: the entry a stopped process left is sent again as it was", async (t) => {
  const fake = new FakeAamio();
  const { sender, homeB, open } = await pair(t, fake);
  const failure = await lostSend(fake, sender);
  const id = failure.message_id;
  const { envelope, w } = sender.outbox[id];
  await sender.close();

  const again = await open(homeB);
  assert.equal(again.outbox[id].status, "unknown");
  assert.deepEqual(again.outboxPending().map((p) => p.message_id), [id]);
  assert.deepEqual(await again.outboxRetry(id), [{ id, w, status: "delivered", http: 201 }]);
  assert.deepEqual(bodies(fake, w), [envelope, envelope]);
  assert.equal((await onDisk(homeB, "outbox.json"))[id].status, "delivered");
});

test("a refusal the service will repeat is not sent again; a rate window, a busy service and a failing one are", async (t) => {
  const fake = new FakeAamio();
  const { sender } = await pair(t, fake);
  const outcome = async (status, text) => {
    fake.failNext(status);
    let failure = null;
    try {
      await sender.send("receiver", { text });
    } catch (error) {
      failure = error;
    }
    return failure;
  };
  const refused = await outcome(403, "refused for good");
  assert.deepEqual([refused.outcome, refused.status, refused.retryable], ["refused", 403, false]);
  assert.match(refused.fix, /will refuse the same bytes again/);
  let before = posts(fake);
  assert.deepEqual(await sender.outboxRetry(refused.message_id), [], "nothing is sent for it");
  assert.equal(posts(fake), before);
  assert.equal(sender.outboxPending().length, 0, "and it is settled: not stored");

  const cases = [[429, "refused", true], [503, "attempted", true], [500, "attempted", null]];
  for (const [status, held, retryable] of cases) {
    const failure = await outcome(status, `answered ${status}`);
    assert.deepEqual([failure.outcome, failure.status, failure.retryable], [held, status, retryable], `a ${status}`);
    const id = failure.message_id;
    assert.equal(outboxRetryable(sender.outbox[id]), true, `${status} is worth sending again`);
    before = posts(fake);
    const [row] = await sender.outboxRetry(id);
    assert.deepEqual([row.status, row.http], ["delivered", 201]);
    assert.equal(posts(fake), before + 1, "one post, the stored bytes");
  }
});

test("a later refusal does not undo an attempt that may have arrived", async (t) => {
  const fake = new FakeAamio();
  const { sender } = await pair(t, fake);
  const failure = await lostSend(fake, sender);
  const id = failure.message_id;
  fake.failNext(410);
  const [row] = await sender.outboxRetry(id);
  assert.deepEqual([row.status, row.http], ["attempted", 410], "the thread is gone now, which says nothing of the attempt that got no answer");
  assert.equal(outboxOutcome(sender.outbox[id]), "attempted");
  assert.deepEqual(sender.outboxPending().map((p) => p.message_id), [id], "still open");
  const dropped = await sender.outboxForget(id);
  assert.deepEqual([dropped.forgotten, dropped.already_sending, dropped.outcome], [true, true, "attempted"]);
  assert.equal(dropped.note, OUTBOX_NOTES.attempted);
});

test("a sweep that stops at one message says what it sent again before it", async (t) => {
  const fake = new FakeAamio();
  const { sender } = await pair(t, fake);
  const first = await lostSend(fake, sender, "one");
  const second = await lostSend(fake, sender, "two");
  // The second one's turn: the outbox cannot be written, so nothing is sent for it.
  const real = sender.saveJson.bind(sender);
  let saves = 0;
  sender.saveJson = async (name, value) => {
    // The first retry writes twice, before its post and after its answer. The third write is the second retry's.
    if (name === "outbox.json" && ++saves === 3) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return real(name, value);
  };
  let stopped = null;
  try {
    await sender.outboxRetry();
  } catch (error) {
    stopped = error;
  }
  assert.equal(stopped?.code, "retry_not_sent", "an earlier attempt of it is still open, and the stop is this attempt's");
  assert.deepEqual([stopped.message_id, stopped.outcome], [second.message_id, "unknown"]);
  assert.deepEqual(stopped.retried.map((row) => [row.id, row.status]), [[first.message_id, "delivered"]], "the one sent again before the stop is not lost from the answer");
});

test("a retry that is delivered while the outbox cannot record it says both, and the next start calls it unknown", async (t) => {
  const fake = new FakeAamio();
  const { sender, homeB, open } = await pair(t, fake);
  const failure = await lostSend(fake, sender);
  const id = failure.message_id;
  // The write before the post works, and the one after the answer does not.
  const real = sender.saveJson.bind(sender);
  let saves = 0;
  sender.saveJson = async (name, value) => {
    if (name === "outbox.json" && ++saves === 2) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return real(name, value);
  };
  const [row] = await sender.outboxRetry(id);
  assert.deepEqual([row.id, row.status, row.http], [id, "delivered", 201], "what the service answered stands");
  assert.match(row.outbox_error, /ENOSPC/);
  assert.match(row.note, /^Delivered: aamio stored it\. The outbox on this machine could not record that/);
  assert.equal((await onDisk(homeB, "outbox.json"))[id].status, "sending", "the file has the write from before the post");
  await sender.close();
  const again = await open(homeB);
  assert.equal(again.outbox[id].status, "unknown", "in flight when the process stopped, as far as the file can say");
  assert.deepEqual((await again.outboxRetry(id)).map((r) => [r.status, r.http]), [["delivered", 201]], "and a retry of it is one more copy of the same bytes, a replay where it lands");
});

test("a name that could be two partners is never a guess in a trace either", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver } = await pair(t, fake);
  await sender.send("receiver", { text: "to the one named exactly" });
  sender.partnersFile.push({ name: "Receiver", key: Keys.generate().public }, { name: "RECEIVER", key: Keys.generate().public });
  assert.equal(sender.trace("receiver").key, receiver.keys.public, "the exact name is the partner");
  assert.throws(() => sender.trace("ReCeIvEr"), { code: "ambiguous_partner" });
  assert.throws(() => sender.trace("Receiver"), { code: "no_trace" }, "and a partner nothing was sent to has no trace");
});

test("forget drops one entry, says which of five it was, and it stays dropped after a restart", async (t) => {
  const fake = new FakeAamio();
  const { sender, homeB, open } = await pair(t, fake);
  const unknown = await lostSend(fake, sender, "unknown");
  const delivered = await sender.send("receiver", { text: "delivered" });
  fake.failNext(403);
  const refused = await sender.send("receiver", { text: "refused" }).catch((error) => error);

  const says = async (runtime, id) => {
    const dropped = await runtime.outboxForget(id);
    return [dropped.forgotten, dropped.already_sending, dropped.outcome, dropped.note === OUTBOX_NOTES[dropped.outcome]];
  };
  assert.deepEqual(await says(sender, unknown.message_id), [true, true, "unknown", true]);
  assert.deepEqual(await says(sender, delivered.message_id), [true, true, "delivered", true]);
  assert.deepEqual(await says(sender, refused.message_id), [true, true, "refused", true]);
  assert.deepEqual(await says(sender, unknown.message_id), [false, false, "not_found", true], "a second time it is not there");
  assert.deepEqual(await onDisk(homeB, "outbox.json"), {});
  await sender.close();

  // Written to the outbox and never handed on: the next start calls it stopped, and nothing left this machine.
  const never = { id: "m-0000000000000001", w: "a".repeat(20), to_key: Keys.generate().public, envelope: "{}", summary: {}, shape: {}, created_at: 1, attempts: 0, status: "sending", last_status: null, replaces: null, tracked: true };
  await writeFile(join(homeB, "outbox.json"), JSON.stringify({ [never.id]: never }));
  const again = await open(homeB);
  assert.equal(again.outbox[never.id].status, "stopped");
  assert.deepEqual(await says(again, never.id), [true, false, "never_sent", true], "only this one lets a caller compose something else");
  await again.close();
  assert.deepEqual((await open(homeB)).outbox, {}, "and it stays dropped");
});

test("a forget that cannot be written leaves the entry where it was", async (t) => {
  const fake = new FakeAamio();
  const { sender, homeB } = await pair(t, fake);
  const failure = await lostSend(fake, sender);
  const id = failure.message_id;
  failSaving(sender, "outbox.json");
  const refused = await sender.outboxForget(id).catch((error) => error);
  assert.equal(refused.code, "not_saved");
  assert.equal(refused.message_id, id);
  assert.equal(sender.outbox[id].status, "unknown", "in memory as on disk");
  assert.equal((await onDisk(homeB, "outbox.json"))[id].status, "unknown");
  assert.deepEqual(sender.outboxPending().map((p) => p.message_id), [id]);
  assert.equal((await sender.outboxForget(id)).forgotten, true, "and it goes once the outbox can be written");
});

test("an outbox the other runtimes wrote is read by their rules", async (t) => {
  // The five outcomes, entry by entry, as aamio-python's outbox_outcome reads them (runtime.py), with what retry and
  // pending make of each. posting is the mark those runtimes set in the moment before the post.
  const table = [
    [{ status: "delivered", attempts: 1, last_status: 201, posting: true }, "delivered", false, false],
    [{ status: "unknown", attempts: 1, last_status: 0, posting: true, ever_open: true }, "unknown", true, true],
    [{ status: "attempted", attempts: 1, last_status: 500, posting: true, ever_open: true }, "attempted", true, true],
    [{ status: "refused", attempts: 1, last_status: 403, posting: true }, "refused", false, false],
    [{ status: "refused", attempts: 1, last_status: 429, posting: true }, "refused", false, true],
    // From before ever_open: a refusal after an answer that proved nothing is read by its last answer.
    [{ status: "refused", attempts: 1, last_status: 500 }, "attempted", true, true],
    [{ status: "refused", attempts: 2, last_status: 410, ever_open: true }, "attempted", true, true],
    // A retry doing its proof of work while the first attempt is still with the other side.
    [{ status: "working", attempts: 2, posting: true }, "attempted", true, true],
    [{ status: "working", attempts: 1 }, "never_sent", false, false],
    [{ status: "stopped", attempts: 1 }, "never_sent", false, false],
    [{ status: "stopped", attempts: 1, posting: true }, "attempted", true, true],
    [{ status: "sending", attempts: 0 }, "never_sent", false, false],
    [{ status: "sending", attempts: 1 }, "attempted", true, true],
  ];
  for (const [entry, outcome, open, retryable] of table) {
    assert.equal(outboxOutcome(entry), outcome, JSON.stringify(entry));
    assert.equal(outboxOpen(entry), open, JSON.stringify(entry));
    assert.equal(outboxRetryable(entry), retryable, JSON.stringify(entry));
  }
  for (const nothing of [null, undefined, "m-1", []]) {
    assert.equal(outboxOutcome(nothing), "not_found");
    assert.equal(outboxRetryable(nothing), false);
  }
  assert.deepEqual(sendAdvice("never_sent", 0)[0], false);
  assert.deepEqual([sendAdvice("unknown", 0)[0], sendAdvice("refused", 429)[0], sendAdvice("attempted", 503)[0], sendAdvice("refused", 403)[0], sendAdvice("attempted", 500)[0]], [null, true, true, false, null]);

  // And a home one of them left: a retry that was working when its process stopped, and a field this runtime does
  // not know. The entry is sent again as it is, and what it does not know stays in the file.
  const fake = new FakeAamio();
  const { receiver, sender, homeB, open } = await pair(t, fake);
  const sent = await sender.send("receiver", { text: "from a home another runtime wrote" });
  const id = sent.message_id;
  await sender.close();
  const file = await onDisk(homeB, "outbox.json");
  Object.assign(file[id], { status: "working", posting: true, ever_open: true, work: { bits: 12, started_at: 1 }, a_field_from_later: { kept: true } });
  await writeFile(join(homeB, "outbox.json"), JSON.stringify(file));
  const again = await open(homeB);
  assert.equal(again.outbox[id].status, "unknown", "an earlier attempt had left: the outcome is open");
  assert.deepEqual((await again.outboxRetry(id)).map((row) => [row.status, row.http]), [["delivered", 201]]);
  const kept = (await onDisk(homeB, "outbox.json"))[id];
  assert.deepEqual([kept.work, kept.a_field_from_later], [{ bits: 12, started_at: 1 }, { kept: true }]);
  assert.deepEqual((await receiver.read()).map((m) => m.replay), [false, true]);
});

// ------------------------------------------------------------------ the trace

test("a send is traced as the service stored it, and nothing of what it said", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver, homeB } = await pair(t, fake);
  const sent = await sender.send("receiver", { text: "the secret text", data: { secret: "value" } });
  assert.equal(sent.trace_error, undefined);
  const view = sender.trace("receiver");
  assert.deepEqual([view.with, view.key], ["receiver", receiver.keys.public]);
  assert.deepEqual(view.sent, [{
    message_id: sent.message_id, at: fake.time, w: sent.w, status: 201, outcome: "delivered", seq: 1, sha256: sent.sha256, sealed: true,
    bytes: Buffer.byteLength(sender.outbox[sent.message_id].envelope, "utf8"), fields: ["data", "from", "reply_to", "text"], text_chars: 15,
    seen_by_them: null, answered_by_them: null,
  }]);
  assert.deepEqual(view.received, []);
  assert.equal(view.last_read, null);
  assert.deepEqual(view.no_read_claim, [sent.message_id]);
  assert.match(view.note, /^Nothing has come back from them, so each is unknown, not unread\./);
  const file = await readFile(join(homeB, "trace.json"), "utf8");
  assert.ok(!file.includes("secret"), "neither the text nor the data is in the file");
  assert.deepEqual(Object.keys(JSON.parse(file)), [receiver.keys.public]);
  assert.deepEqual(sender.trace(), { counterparts: [{ with: "receiver", key: receiver.keys.public, sent: 1, received: 0, last_sent_at: fake.time, last_received_at: null, no_read_claim: 1 }], note: "Name one with who for the messages themselves, as hashes." });
});

test("a reply says what it answers and what was read, and the trace puts the two together", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver } = await pair(t, fake);
  const first = await sender.send("receiver", { text: "the question" });
  const [got] = await receiver.read();
  assert.equal(got.sha256, first.sha256);
  assert.equal(got.body.seen, undefined, "nothing of the receiver's had been read when it was written");
  const reply = await receiver.send("sender", { text: "the answer", re: got.sha256 });
  const [back] = await sender.read();
  assert.deepEqual([back.body.re, back.body.seen], [first.sha256, first.sha256], "it answers the question, and names it as the last one read and opened");

  const view = sender.trace("receiver");
  assert.deepEqual([view.sent[0].seen_by_them, view.sent[0].answered_by_them], [true, true]);
  assert.deepEqual(view.received.map((row) => [row.channel, row.seq, row.sha256, row.encrypted, row.format, row.error, row.fields, row.re, row.seen]),
    [["inbox", 1, reply.sha256, true, "json", null, ["from", "re", "reply_to", "seen", "text"], first.sha256, first.sha256]]);
  assert.deepEqual(view.received[0].answers, { seq: 1, sha256: first.sha256, at: fake.time });
  assert.deepEqual(view.received[0].acknowledges, { seq: 1, sha256: first.sha256, at: fake.time });
  assert.deepEqual(view.no_read_claim, []);
  assert.equal(view.note, "1 delivered, and their runtime says it read and opened 1 of them. A claim covers the one message it names. It says their runtime opened it, not that anyone understood it or acted on it.");
  assert.deepEqual(view.last_read, { sha256: reply.sha256, seq: 1, w: sender.channel("inbox").w, at: fake.time });

  // And the other side's record of the same two messages.
  const theirs = receiver.trace(sender.keys.public);
  assert.equal(theirs.with, "sender");
  assert.deepEqual([theirs.sent[0].re, theirs.sent[0].seen, theirs.sent[0].sha256], [first.sha256, first.sha256, reply.sha256]);
  assert.deepEqual(theirs.received.map((row) => row.sha256), [first.sha256]);
});

test("a claim covers the message it names: one sent after it, or before it and never named, is unknown, not unread", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver } = await pair(t, fake);
  const one = await sender.send("receiver", { text: "one" });
  const two = await sender.send("receiver", { text: "two" });
  await receiver.read();
  // The receiver's next message names the last it read and opened: two.
  await receiver.send("sender", { text: "got them" });
  await sender.read();
  const three = await sender.send("receiver", { text: "three" });
  const view = sender.trace("receiver");
  assert.deepEqual(view.sent.map((row) => [row.message_id, row.seen_by_them]), [[one.message_id, null], [two.message_id, true], [three.message_id, null]]);
  assert.deepEqual(view.no_read_claim, [one.message_id, three.message_id]);
  assert.match(view.note, /^3 delivered, and their runtime says it read and opened 1 of them\. For 2 there is no claim kept here: that is unknown, not unread/);
  // A limit shows the newest rows, and the note still speaks of all of them.
  const short = sender.trace("receiver", 1);
  assert.deepEqual(short.sent.map((row) => row.message_id), [three.message_id]);
  assert.equal(short.note, view.note);
});

test("a message that cannot claim to be from the partner claims nothing for the partner", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver } = await pair(t, fake);
  const sent = await sender.send("receiver", { text: "is this read?" });
  // A stranger, signed by its own key, on the sender's board inbox, naming the message as read.
  const board = await sender.ensureBoardInbox(600);
  const stranger = new Aamio({ base: HOST, keys: Keys.generate(), fetch: (url, init) => fake.fetch(url, init) });
  await stranger.send(board.w, JSON.stringify({ text: "I read it", seen: sent.sha256 }));
  // And nobody at all, on an address open to anyone.
  const thread = await sender.client.open({ ttl: 600 });
  sender.state.channels.push({ label: "side", read_key: thread.id, w: thread.w, expire_at: thread.expireAt, allow: [], after: 0, created_at: null, instance: null, gone: false, muted: false, seen: [], seen_from: [] });
  await fake.fetch(`${HOST}/${thread.w}`, { method: "POST", body: JSON.stringify({ text: "so did I", seen: sent.sha256 }) });
  const read = await sender.read();
  assert.deepEqual(read.map((m) => [m.channel, m.verified, m.known_contact]).sort(), [["board", true, false], ["side", false, false]]);

  const view = sender.trace("receiver");
  assert.equal(view.sent[0].seen_by_them, null, "what the partner's key did not sign says nothing of the partner");
  assert.deepEqual(view.received, []);
  // The stranger has a record of its own, under its own key, where its claim names nothing sent to it.
  const theirs = sender.trace(stranger.keys.public);
  assert.deepEqual(theirs.received.map((row) => [row.seen, row.acknowledges]), [[sent.sha256, { sha256: sent.sha256, note: "no confirmed send in this record has this sha256" }]]);
  assert.deepEqual(sender.trace().counterparts.map((row) => row.with).sort(), ["receiver", stranger.keys.public].sort(), "and the unsigned one has none: it is from nobody");
});

test("a message that could not be opened is recorded and not named as read, and an old one sent again does not move seen back", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver } = await pair(t, fake);
  const inbox = receiver.channel("inbox");
  const one = await sender.send("receiver", { text: "one" });
  await receiver.read();
  // From the partner, signed, and sealed to a key that is not the receiver's: it arrives and cannot be opened.
  const unreadable = sender.keys.seal(Keys.generate().public, JSON.stringify({ text: "for somebody else" }));
  await fake.fetch(`${HOST}/${inbox.w}`, { method: "POST", body: unreadable, headers: { "X-Key": sender.keys.public, "X-Sig": sender.keys.sign(threadSigningInput(inbox.w, unreadable)) } });
  const [closed] = await receiver.read();
  assert.deepEqual([closed.format, closed.verified], ["unreadable", true]);
  let view = receiver.trace("sender");
  assert.deepEqual(view.received.map((row) => [row.sha256, row.format, row.fields, typeof row.error]), [[one.sha256, "json", ["from", "reply_to", "text"], "object"], [sha256hex(unreadable), "unreadable", null, "string"]]);
  assert.equal(view.last_read.sha256, one.sha256, "last read is the last one opened");

  const two = await sender.send("receiver", { text: "two" });
  await receiver.read();
  // The first message again, the same bytes: a replay, neither recorded twice nor read again.
  const again = fake.threads.get(inbox.w).messages[0];
  await fake.fetch(`${HOST}/${inbox.w}`, { method: "POST", body: again.body, headers: { "X-Key": sender.keys.public, "X-Sig": again.sig } });
  const [copy] = await receiver.read();
  assert.equal(copy.replay, true);
  view = receiver.trace("sender");
  assert.equal(view.received.length, 3);
  assert.equal(view.last_read.sha256, two.sha256, "seen does not move back to an old message sent again");
  await receiver.send("sender", { text: "which did I read last?" });
  const [said] = await sender.read();
  assert.equal(said.body.seen, two.sha256);
});

test("a retry replaces its row: one row per message, with the answer that settled it", async (t) => {
  const fake = new FakeAamio();
  const { sender } = await pair(t, fake);
  const failure = await lostSend(fake, sender);
  let view = sender.trace("receiver");
  assert.deepEqual(view.sent.map((row) => [row.message_id, row.status, row.outcome, row.sha256, row.seq]), [[failure.message_id, 0, "unknown", null, null]]);
  assert.match(view.note, /^No message here has an answer from the service that confirms it was stored\. For 1 no answer settled whether the service stored it, so it may be stored already\./);
  await sender.outboxRetry(failure.message_id);
  view = sender.trace("receiver");
  assert.deepEqual(view.sent.map((row) => [row.message_id, row.status, row.outcome, row.seq]), [[failure.message_id, 201, "delivered", 2]]);
  assert.match(view.sent[0].sha256, /^[0-9a-f]{64}$/);
});

test("an answer on the board is traced under the poster's key, and names what was read of theirs", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver } = await pair(t, fake);
  const posted = await receiver.boardPost({ kind: "need", title: "a need", text: "who can help?" });
  const done = await sender.boardAnswer(posted.post.id, { text: "I can" });
  assert.equal(done.trace_error, undefined);
  const view = sender.trace(receiver.keys.public);
  assert.deepEqual(view.sent.map((row) => [row.message_id, row.status, row.fields]), [[done.message_id, 201, ["from", "post", "reply_to", "text"]]]);
  // A write address stands for the key it is bound to.
  assert.deepEqual(sender.trace(posted.inbox).sent.map((row) => row.message_id), [done.message_id]);
  const [answer] = await receiver.read();
  assert.equal(answer.channel, "board");
  // The poster writes back, and the next answer to a post of theirs names that as seen.
  const back = await receiver.send(answer.body.reply_to, { text: "thank you" });
  await sender.read();
  const second = await receiver.boardPost({ kind: "need", title: "another", text: "and this?" });
  await sender.boardAnswer(second.post.id, { text: "that too" });
  const [again] = await receiver.read();
  assert.equal(again.body.seen, back.sha256);
});

test("what a read did not hand over is not traced, and is when it is handed over", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver } = await pair(t, fake);
  const sent = await sender.send("receiver", { text: "once" });
  failSaving(receiver, "state.json");
  assert.deepEqual(await receiver.read(), [], "not handed over while its place could not be written down");
  assert.equal(receiver.traces[sender.keys.public], undefined, "so not read, and not traced");
  assert.equal((await receiver.read()).length, 1);
  assert.equal(receiver.trace("sender").last_read.sha256, sent.sha256);
});

for (const [what, damage] of [
  ["not JSON", "{ this is not json"],
  ["a list", "[1, 2, 3]"],
  ["books of the wrong shape", (key) => JSON.stringify({ [key]: { sent: "x", received: [1, { sha256: 7 }, { seq: "one" }], last_read: [], active: "never" }, "not a key": { sent: [] } })],
  ["a row with a field of the wrong type", (key) => JSON.stringify({ [key]: { sent: [{ message_id: "m-1", status: "201", fields: { not: "a list" }, sha256: 12 }], received: [], last_read: { sha256: "short" }, active: 5 } })],
]) {
  test(`a trace file that holds ${what} never turns a delivered send into an error`, async (t) => {
    const fake = new FakeAamio();
    const { sender, receiver, homeB, open } = await pair(t, fake);
    await sender.close();
    await writeFile(join(homeB, "trace.json"), typeof damage === "function" ? damage(receiver.keys.public) : damage);
    const again = await open(homeB);
    const sent = await again.send("receiver", { text: "delivered all the same" });
    assert.equal(sent.seq, 1);
    assert.equal(sent.trace_error, undefined);
    const view = again.trace("receiver");
    assert.equal(view.sent[view.sent.length - 1].message_id, sent.message_id);
    for (const row of view.sent) for (const [name, value] of Object.entries(row)) {
      assert.ok(value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value), `${name} is a value a row may hold`);
    }
    assert.deepEqual(Object.keys(await onDisk(homeB, "trace.json")), [receiver.keys.public], "and the file holds what a trace holds again");
    const said = (await again.attentionTaken()).filter((note) => note.state === "untraced");
    assert.equal(said.length, typeof damage === "function" ? 0 : 1, "a file that could not be used at all is said; rows of the wrong shape are left out");
  });
}

test("a trace file that cannot be read never stops the runtime, and a trace that cannot be saved costs the trace and nothing else", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver, homeB, open } = await pair(t, fake);
  await sender.close();
  // A folder where the file should be: it is there, and it cannot be read.
  await mkdir(join(homeB, "trace.json"));
  const again = await open(homeB);
  const start = (await again.attentionTaken()).filter((note) => note.state === "untraced");
  assert.equal(start.length, 1);
  assert.match(start[0].what, /^trace\.json could not be read .*The sends and reads themselves are unaffected/);

  // It cannot be replaced either: the send is delivered, and says the trace is behind.
  const sent = await again.send("receiver", { text: "delivered, untraced" });
  assert.equal(sent.seq, 1);
  assert.match(sent.trace_error, /^trace\.json: /);
  assert.equal(again.outbox[sent.message_id].status, "delivered");
  assert.equal(again.outbox[sent.message_id].trace_error, undefined, "the outbox keeps no diagnostics of the trace");
  assert.ok((await again.attentionTaken()).some((note) => note.state === "untraced"));
  assert.equal(again.trace("receiver").sent.length, 1, "what this process knows it still shows");

  // The same for a read: the message is handed over as it was weighed, and attention says the trace is behind.
  await receiver.send("sender", { text: "read, untraced" });
  const [got] = await again.read();
  assert.equal(got.body.text, "read, untraced");
  assert.equal(got.trace_error, undefined, "nothing is added to a message after it was weighed");
  assert.ok((await again.attentionTaken()).some((note) => note.state === "untraced" && note.what.startsWith("trace.json: ")));
  assert.equal(again.channel("inbox").after, 1, "and the read stands");
});

test("the trace survives a restart, keeps fifty messages each way and a hundred counterparts", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver, homeB, open } = await pair(t, fake);
  const sent = await sender.send("receiver", { text: "before the restart" });
  await receiver.send("sender", { text: "and back" });
  await sender.read();
  const before = sender.trace("receiver");
  await sender.close();
  const again = await open(homeB);
  assert.deepEqual(again.trace("receiver"), before);
  assert.deepEqual(again.trace().counterparts.map((row) => [row.with, row.sent, row.received]), [["receiver", 1, 1]]);

  // Fifty each way: the oldest go first.
  const stranger = Keys.generate().public;
  for (let n = 0; n < TRACE_KEEP + 10; n++) {
    await again.traceSent({ id: `m-${String(n).padStart(16, "0")}`, to_key: stranger, w: "a".repeat(20), status: "delivered", shape: { bytes: 10, fields: ["text"], text_chars: 1 } }, 201, { seq: n + 1, sha256: sha256hex(String(n)) });
    again.traceReceived({ label: "inbox", w: "b".repeat(20) }, { from_key: stranger, verified: true, replay: false, format: "json", encrypted: true, seq: n + 1, at: 1, sha256: sha256hex("r" + n), body: { text: "x" } });
  }
  const book = (await onDisk(homeB, "trace.json"))[stranger];
  assert.deepEqual([book.sent.length, book.sent[0].seq, book.sent[TRACE_KEEP - 1].seq], [TRACE_KEEP, 11, TRACE_KEEP + 10]);
  assert.equal(again.traces[stranger].received.length, TRACE_KEEP);
  assert.equal(again.trace(stranger, 50).sent.length, 50);
  assert.equal(again.trace(stranger).sent.length, 20, "twenty unless more are asked for");

  // A hundred counterparts: the ones longest quiet go first, and never the one being written.
  for (let n = 0; n < TRACE_KEYS + 5; n++) {
    fake.time += 1;
    again.traceBook(Keys.generate().public);
  }
  assert.equal(Object.keys(again.traces).length, TRACE_KEYS);
  assert.equal(again.traces[receiver.keys.public], undefined, "the oldest record went");
  assert.equal(sent.seq, 1);
});

test("a message made of thousands of field names does not make the trace large", async (t) => {
  // The names of a message's fields are its sender's to choose, and a board inbox takes any signed key. One message
  // of nearly the largest size, all of it names: the row keeps a bounded few, and the file stays small.
  const fake = new FakeAamio();
  const { sender, homeB } = await pair(t, fake);
  const board = await sender.ensureBoardInbox(600);
  const stranger = new Aamio({ base: HOST, keys: Keys.generate(), fetch: (url, init) => fake.fetch(url, init) });
  const body = { text: "ordinary text", ["x".repeat(200)]: 1 };
  for (let n = 0; n < 4000; n++) body[`field${String(n).padStart(5, "0")}`] = 1;
  const sent = JSON.stringify(body);
  assert.ok(sent.length > 50_000 && sent.length < 65_536);
  await stranger.send(board.w, sent);
  const [got] = await sender.read();
  assert.equal(Object.keys(got.body).length, 4002, "the message itself is handed over whole");
  const [row] = sender.trace(stranger.keys.public).received;
  assert.equal(row.fields.length, TRACE_FIELDS);
  assert.ok(row.fields.every((name) => name.length <= TRACE_FIELD_CHARS));
  assert.equal(row.text_chars, 13, "and what else the row says of it is as before");
  assert.ok((await readFile(join(homeB, "trace.json"), "utf8")).length < 4000, "the file is the size of its rows, not of the message");
  // And a file that already holds such a row is cut to the same bound when it is read.
  const long = normalizeTraces({ [stranger.keys.public]: { sent: [], received: [{ sha256: "a".repeat(64), fields: Object.keys(body) }], last_read: null, active: 1 } });
  assert.equal(long[stranger.keys.public].received[0].fields.length, TRACE_FIELDS);
  // A name is measured in characters, as aamio-python and aamio-php measure it: sixty-four of an emoji are 128 units.
  const counted = normalizeTraces({ [stranger.keys.public]: { sent: [], received: [{ sha256: "a".repeat(64), fields: ["\u{1F600}".repeat(64), "\u{1F600}".repeat(65), "text"] }], last_read: null, active: 1 } });
  assert.deepEqual(counted[stranger.keys.public].received[0].fields, ["text", "\u{1F600}".repeat(64)]);
});

test("trace.json as the other runtimes write it is read as it is, and written back the same", async (t) => {
  // A book as aamio-python writes one (tests/test_conversation_trace.py): the fields in its order, null where a
  // value is not known, and nothing else. Read and written back, it is the same file.
  const key = Keys.generate().public;
  const hash = (text) => sha256hex(text);
  const book = {
    sent: [
      { message_id: "m-00000000000000a1", at: 1790000000, w: "a".repeat(20), status: 201, outcome: "delivered", seq: 1, sha256: hash("one"), sealed: true, bytes: 412, fields: ["from", "reply_to", "text"], text_chars: 3 },
      { message_id: "m-00000000000000a2", at: 1790000005, w: "a".repeat(20), status: 0, outcome: "unknown", seq: null, sha256: null, sealed: true, bytes: 420, fields: ["from", "re", "reply_to", "seen", "text"], text_chars: 9, re: hash("theirs"), seen: hash("theirs") },
    ],
    received: [
      { at: 1790000003, channel: "inbox", w: "b".repeat(20), seq: 1, sha256: hash("theirs"), encrypted: true, format: "json", error: null, fields: ["from", "reply_to", "seen", "text"], text_chars: 6, re: null, seen: hash("one") },
    ],
    last_read: { sha256: hash("theirs"), seq: 1, w: "b".repeat(20), at: 1790000003 },
    active: 1790000005,
  };
  assert.deepEqual(normalizeTraces({ [key]: book }), { [key]: book });
  assert.equal(JSON.stringify(normalizeTraces({ [key]: book })), JSON.stringify({ [key]: book }), "field for field, in the same order");
  const view = traceView(book, 20);
  assert.deepEqual(view.sent.map((row) => [row.seen_by_them, row.answered_by_them]), [[true, null], [null, null]]);
  assert.deepEqual(view.no_read_claim, []);
  assert.match(view.note, /^1 delivered, and their runtime says it read and opened 1 of them\. For 1 no answer settled whether the service stored it/);

  const fake = new FakeAamio();
  const { a: home, open } = await fixture(t, fake, "a");
  await writeFile(join(home, "trace.json"), JSON.stringify({ [key]: book }));
  const runtime = await open(home);
  assert.deepEqual(runtime.trace(key).last_read, book.last_read);
  assert.equal(runtime.conversation(key).seen, hash("theirs"), "the next message to them names what the other runtime last read");
  await runtime.saveTrace();
  assert.deepEqual(await onDisk(home, "trace.json"), { [key]: book });
});

// ------------------------------------------------------------------ over MCP and on the command line

test("over MCP: the three tools are there, a retry takes one id, and each refusal says what to do", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver } = await pair(t, fake);
  const tools = (await call(sender, "tools/list")).result.tools;
  assert.equal(tools.length, 24);
  for (const name of ["aamio_trace", "aamio_outbox_retry", "aamio_outbox_forget"]) assert.ok(tools.some((tool) => tool.name === name), name);
  assert.deepEqual(tools.find((tool) => tool.name === "aamio_outbox_retry").inputSchema.required, ["id"], "settling one is a decision per message, never a sweep");
  const unsaid = (await call(sender, "aamio_outbox_retry", {})).result;
  assert.deepEqual([unsaid.isError, unsaid.structuredContent.error_code], [true, "invalid_arguments"]);
  // A name spelt wrong is the call's answer too, as in aamio-python and aamio-php, where it was passed over.
  const typo = (await call(sender, "aamio_trace", { lmit: 5 })).result;
  assert.deepEqual([typo.isError, typo.structuredContent.error_code, typo.structuredContent.error], [true, "invalid_arguments", "aamio_trace takes no argument called lmit"]);
  // A string's length is counted in characters, as JSON Schema and the other two count it: 64 of them fit, in any plane.
  const sixtyFour = (await call(sender, "aamio_outbox_forget", { id: "\u{1F600}".repeat(64) })).result;
  assert.notEqual(sixtyFour.structuredContent.error_code, "invalid_arguments", JSON.stringify(sixtyFour.structuredContent));
  const sixtyFive = (await call(sender, "aamio_outbox_forget", { id: "\u{1F600}".repeat(65) })).result;
  assert.deepEqual([sixtyFive.isError, sixtyFive.structuredContent.error_code], [true, "invalid_arguments"]);

  // A send that failed says its id, whether the same bytes are worth sending again, and how.
  fake.failNext("lost");
  const failed = (await call(sender, "aamio_send", { to: "receiver", text: "lost on the way back" })).result;
  assert.equal(failed.isError, true);
  const told = failed.structuredContent;
  assert.deepEqual([told.error_code, told.outcome, told.status, told.retryable], ["send_failed", "unknown", 0, null]);
  assert.match(told.fix, /aamio_outbox_retry with this id/);
  const id = told.message_id;
  assert.deepEqual((await call(sender, "aamio_pending", {})).result.structuredContent.pending.map((p) => p.message_id), [id]);

  const retried = (await call(sender, "aamio_outbox_retry", { id })).result;
  assert.equal(retried.isError, false);
  assert.deepEqual(retried.structuredContent, { id, w: receiver.channel("inbox").w, status: "delivered", http: 201 });
  const again = (await call(sender, "aamio_outbox_retry", { id })).result;
  assert.equal(again.isError, true);
  assert.deepEqual([again.structuredContent.retried, again.structuredContent.outcome, again.structuredContent.fix], [false, "delivered", "It is delivered, so sending it again would be a second copy."]);
  const unknown = (await call(sender, "aamio_outbox_retry", { id: "m-ffffffffffffffff" })).result;
  assert.deepEqual([unknown.isError, unknown.structuredContent.retried, unknown.structuredContent.why], [true, false, "this outbox has no message with that id"]);

  const trace = (await call(sender, "aamio_trace", { who: "receiver", limit: 5 })).result;
  assert.equal(trace.isError, false);
  assert.deepEqual(trace.structuredContent.sent.map((row) => [row.message_id, row.status]), [[id, 201]]);
  assert.deepEqual((await call(sender, "aamio_trace", {})).result.structuredContent.counterparts.map((row) => row.with), ["receiver"]);
  const nobody = (await call(sender, "aamio_trace", { who: "nobody" })).result;
  assert.deepEqual([nobody.isError, nobody.structuredContent.error_code], [true, "no_trace"]);
  const over = (await call(sender, "aamio_trace", { limit: 51 })).result;
  assert.deepEqual([over.isError, over.structuredContent.error_code], [true, "invalid_arguments"]);

  const forgotten = (await call(sender, "aamio_outbox_forget", { id })).result;
  assert.deepEqual([forgotten.isError, forgotten.structuredContent.forgotten, forgotten.structuredContent.outcome, forgotten.structuredContent.already_sending], [false, true, "delivered", true]);
  const gone = (await call(sender, "aamio_outbox_forget", { id })).result.structuredContent;
  assert.deepEqual([gone.forgotten, gone.outcome], [false, "not_found"]);
});

test("on the command line: retry, forget and trace answer from the home's files, and a usage error leaves the home alone", async (t) => {
  const fake = new FakeAamio();
  const { sender, receiver, homeB, root } = await pair(t, fake);
  const sent = await sender.send("receiver", { text: "for the command line" });
  await sender.close();
  // Nothing here is worth sending again, so no command below goes anywhere: the host is one that answers nobody.
  const cli = (...args) => spawnSync(process.execPath, [bin, "--home", homeB, ...args], { encoding: "utf8", timeout: 30_000, env: { ...process.env, AAMIO_HOST: "http://127.0.0.1:9", AAMIO_BOARD: "http://127.0.0.1:9" } });
  const said = (run) => {
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  assert.deepEqual(said(cli("outbox", "retry")), { retried: [] });
  assert.deepEqual(said(cli("outbox", "retry", "--id", sent.message_id)), { retried: [] }, "delivered: not sent again");
  const everyone = said(cli("trace"));
  assert.deepEqual(everyone.counterparts.map((row) => [row.with, row.sent]), [["receiver", 1]]);
  const one = said(cli("trace", "receiver", "--limit", "1"));
  assert.deepEqual(one.sent.map((row) => [row.message_id, row.sha256]), [[sent.message_id, sent.sha256]]);
  assert.deepEqual(said(cli("trace", receiver.keys.public)).key, receiver.keys.public);
  const nobody = cli("trace", "nobody");
  assert.equal(nobody.status, 1);
  assert.equal(nobody.stdout, "");
  assert.match(nobody.stderr, /nothing sent to or received from nobody is recorded here/);

  const dropped = said(cli("outbox", "forget", sent.message_id));
  assert.deepEqual([dropped.id, dropped.forgotten, dropped.already_sending, dropped.outcome], [sent.message_id, true, true, "delivered"]);
  assert.deepEqual(said(cli("outbox", "forget", sent.message_id)).outcome, "not_found");
  assert.deepEqual(await onDisk(homeB, "outbox.json"), {});

  // What can be seen to be wrong is refused before the home is opened or made.
  const unused = join(root, "never-made");
  for (const args of [["outbox", "forget"], ["outbox", "forget", "a", "b"], ["outbox", "retry", "extra"], ["outbox", "retry", "--id"], ["trace", "a", "b"], ["trace", "--limit", "0"], ["trace", "--limit", "51"], ["outbox", "retry", "--all"]]) {
    const refused = spawnSync(process.execPath, [bin, "--home", unused, ...args], { encoding: "utf8", timeout: 30_000 });
    assert.equal(refused.status, 2, `${args.join(" ")}: ${refused.stderr}`);
    assert.equal(refused.stdout, "");
  }
  assert.equal(existsSync(unused), false);
});

// ------------------------------------------------------------------ a check of 12 November 2026
//
// Three ways a stop was said in words that fit another stop. In the first two the words were those of a message that
// was never stored, about one that may be with the recipient, which is leave to write it again as a new message.

const failed = async (act) => {
  try {
    await act();
  } catch (error) {
    return error;
  }
  return null;
};

test("an attempt an older client left open stays open when its retry is refused, through a restart and a forget", async (t) => {
  // An entry written before ever_open, answered 500 and called refused, is open: the service may have stored the
  // message before it failed. Its retry was answered 410, and the entry read refused, not stored: gone from pending,
  // and forget said the message had never been stored.
  const fake = new FakeAamio();
  const { sender, homeB, open } = await pair(t, fake);
  const first = await sender.send("receiver", { text: "answered 500 by an older client" });
  const second = await sender.send("receiver", { text: "turned away by a rate window" });
  await sender.close();
  const file = await onDisk(homeB, "outbox.json");
  const asOlder = (id, last) => {
    for (const field of ["ever_open", "posting", "seq"]) delete file[id][field];
    Object.assign(file[id], { status: "refused", last_status: last, attempts: 1 });
  };
  asOlder(first.message_id, 500);
  asOlder(second.message_id, 429);
  await writeFile(join(homeB, "outbox.json"), JSON.stringify(file));

  const id = first.message_id;
  let again = await open(homeB);
  assert.equal(outboxOutcome(again.outbox[id]), "attempted");
  assert.deepEqual(again.outboxPending().map((p) => p.message_id), [id]);
  fake.failNext(410);
  const [row] = await again.outboxRetry(id);
  assert.deepEqual([row.status, row.http], ["attempted", 410], "the thread is gone now, which says nothing of the attempt that was answered 500");
  assert.equal(outboxOutcome(again.outbox[id]), "attempted");
  assert.deepEqual(again.outboxPending().map((p) => p.message_id), [id], "still open");

  // A rate window proved that nothing was stored, so a refusal of its retry is a refusal: nothing was ever left open.
  fake.failNext(410);
  const [other] = await again.outboxRetry(second.message_id);
  assert.deepEqual([other.status, other.http], ["refused", 410]);
  assert.equal(outboxOutcome(again.outbox[second.message_id]), "refused");
  assert.deepEqual(again.outboxPending().map((p) => p.message_id), [id]);

  await again.close();
  const kept = await onDisk(homeB, "outbox.json");
  assert.equal(kept[id].ever_open, true, "and the file says it was left open");
  assert.notEqual(kept[second.message_id].ever_open, true);
  again = await open(homeB);
  assert.equal(outboxOutcome(again.outbox[id]), "attempted", "after a restart too");
  assert.deepEqual(again.outboxPending().map((p) => p.message_id), [id]);
  const dropped = await again.outboxForget(id);
  assert.deepEqual([dropped.forgotten, dropped.already_sending, dropped.outcome, dropped.note], [true, true, "attempted", OUTBOX_NOTES.attempted]);
  const settled = await again.outboxForget(second.message_id);
  assert.deepEqual([settled.forgotten, settled.outcome], [true, "refused"]);
});

test("a retry that stops before its post says the earlier attempt may have arrived, and to retry the same id", async (t) => {
  // The disk was full when a message left unknown was sent again. Nothing went out, and the answer said the message
  // "was not sent. Free the disk, then send it again", with outcome unknown beside it.
  const fake = new FakeAamio();
  const { sender, receiver } = await pair(t, fake);
  const id = (await lostSend(fake, sender)).message_id;
  const before = posts(fake);
  failSaving(sender, "outbox.json");
  const stopped = await failed(() => sender.outboxRetry(id));
  assert.equal(stopped?.code, "retry_not_sent");
  assert.deepEqual([stopped.message_id, stopped.outcome, stopped.retryable], [id, "unknown", null]);
  assert.equal(stopped.message, `the outbox could not be written (ENOSPC), so this attempt of message ${id} was not sent. An earlier attempt of it left this machine and may have arrived, so its outcome is still unknown.`);
  assert.match(stopped.fix, /^Free the disk, then retry the same message: aamio_outbox_retry with this id, or aamio outbox retry --id/);
  assert.match(stopped.fix, /Do not compose a replacement/);
  assert.doesNotMatch(stopped.message + " " + stopped.fix, /send it again/);
  assert.equal(posts(fake), before, "nothing went out for this attempt");
  assert.equal(outboxOutcome(sender.outbox[id]), "unknown");
  assert.deepEqual(sender.outboxPending().map((p) => p.message_id), [id], "and it is still to be settled");
  // Both the command line and the local server write the stop out with this function.
  assert.deepEqual(stopFields(stopped), { outcome: "unknown", message_id: id, retryable: null });

  // The local server says the same: the code, the id and the outcome, and no word of a new message.
  failSaving(sender, "outbox.json");
  const over = (await call(sender, "aamio_outbox_retry", { id })).result;
  assert.equal(over.isError, true);
  assert.deepEqual([over.structuredContent.error_code, over.structuredContent.outcome, over.structuredContent.message_id, over.structuredContent.retryable], ["retry_not_sent", "unknown", id, null]);
  assert.match(over.structuredContent.error, /this attempt of message m-[0-9a-f]{16} was not sent\. An earlier attempt of it left this machine and may have arrived/);
  assert.match(over.structuredContent.fix, /^Free the disk, then retry the same message/);
  assert.equal(posts(fake), before);

  // The same id once the disk takes writes: the stored bytes, a replay where the first arrived.
  const [row] = await sender.outboxRetry(id);
  assert.deepEqual([row.status, row.http], ["delivered", 201]);
  assert.deepEqual((await receiver.read()).map((m) => m.replay), [false, true]);

  // A message that never left keeps its own words: nothing of it is anywhere, so it is sent again as it is written.
  failSaving(sender, "outbox.json");
  const unwritten = await failed(() => sender.send("receiver", { text: "never written down" }));
  assert.deepEqual([unwritten?.code, unwritten.outcome], ["not_sent", "stopped"]);
  assert.match(unwritten.message, /was neither recorded nor sent\. Free the disk, then send it again\.$/);
  const real = sender.saveJson.bind(sender);
  let saves = 0;
  sender.saveJson = async (name, value) => {
    // Written to the outbox, and the write that says it is on its way fails.
    if (name === "outbox.json" && ++saves === 2) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return real(name, value);
  };
  const unsent = await failed(() => sender.send("receiver", { text: "written down, and never sent" }));
  assert.deepEqual([unsent?.code, unsent.outcome], ["not_sent", "stopped"]);
  assert.match(unsent.message, /was not sent\. Free the disk, then send it again\.$/);
  assert.equal(outboxOutcome(sender.outbox[unsent.message_id]), "never_sent");
});

test("a retry stopped at the gate says which message it was, and what an earlier attempt left open", async (t) => {
  // The gate's words are about the attempt it stopped: "nothing was sent". Of a message whose first attempt got no
  // answer that is not the whole of it, and the stop named neither the message nor its outcome.
  const fake = new FakeAamio();
  const { sender } = await pair(t, fake);
  const open = (await lostSend(fake, sender)).message_id;
  fake.failNext(429);
  const turned = (await failed(() => sender.send("receiver", { text: "turned away by a rate window" }))).message_id;
  const before = posts(fake);
  sender.client.planFor = async () => {
    throw new GateStop("This inbox requires something, a condition this client does not know how to meet, so nothing was sent.", "Update the aamio client.");
  };
  const stopped = await failed(() => sender.outboxRetry(open));
  assert.ok(stopped instanceof GateStop);
  assert.deepEqual([stopped.message_id, stopped.outcome], [open, "unknown"]);
  assert.match(stopped.earlier_attempt, /^This stop is about this attempt only\. An earlier attempt of it left this machine and may have arrived, so its outcome is still unknown\. When the gate can be met, retry the same message/);
  assert.deepEqual(Object.keys(stopFields(stopped)), ["outcome", "message_id", "earlier_attempt"]);
  // One the rate window turned away was never stored, and the stop does not say that it may have been.
  const settled = await failed(() => sender.outboxRetry(turned));
  assert.deepEqual([settled.message_id, settled.outcome, settled.earlier_attempt], [turned, "refused", undefined]);
  assert.equal(posts(fake), before);

  const over = (await call(sender, "aamio_outbox_retry", { id: open })).result;
  assert.equal(over.isError, true);
  assert.deepEqual([over.structuredContent.error_code, over.structuredContent.message_id, over.structuredContent.outcome], ["gate", open, "unknown"]);
  assert.match(over.structuredContent.earlier_attempt, /may have arrived/);
  // A send stopped at the gate is a message that never left: it names no outcome of an earlier attempt.
  const fresh = (await call(sender, "aamio_send", { to: "receiver", text: "stopped at the gate" })).result;
  assert.deepEqual([fresh.structuredContent.error_code, fresh.structuredContent.earlier_attempt], ["gate", undefined]);
});

test("a send the service turned away says the trace that could not be written too", async (t) => {
  // The answer was 429 and trace.json could not be written. The failure said the 429 and not the trace: that was in
  // attention, which a command that sends once and exits never fetches.
  const fake = new FakeAamio();
  const { sender, receiver } = await pair(t, fake);
  failSaving(sender, "trace.json", 99);
  fake.failNext(429);
  const turned = await failed(() => sender.send("receiver", { text: "turned away, and untraced" }));
  assert.deepEqual([turned?.code, turned.status, turned.outcome, turned.retryable], ["send_failed", 429, "refused", true]);
  assert.match(turned.trace_error, /^trace\.json: ENOSPC/);
  assert.deepEqual(Object.keys(stopFields(turned)), ["outcome", "message_id", "status", "trace_error", "retryable"]);

  fake.failNext(429);
  const over = (await call(sender, "aamio_send", { to: "receiver", text: "the same over the local server" })).result;
  assert.equal(over.isError, true);
  assert.deepEqual([over.structuredContent.error_code, over.structuredContent.status, over.structuredContent.retryable], ["send_failed", 429, true]);
  assert.match(over.structuredContent.trace_error, /^trace\.json: ENOSPC/);
  assert.match(over.structuredContent.fix, /declined this for now/);

  // An answer on the board goes the way a send goes, and says the same.
  const posted = await receiver.boardPost({ kind: "need", title: "a need", text: "who can help?" });
  fake.failNext(500);
  const answer = await failed(() => sender.boardAnswer(posted.post.id, { text: "I can" }));
  assert.deepEqual([answer?.code, answer.status, answer.outcome], ["send_failed", 500, "attempted"]);
  assert.match(answer.trace_error, /^trace\.json: ENOSPC/);
  fake.failNext(500);
  const second = (await call(sender, "aamio_board_answer", { post: posted.post.id, text: "over the local server" })).result;
  assert.deepEqual([second.isError, second.structuredContent.operation, second.structuredContent.status], [true, "board_answer", 500]);
  assert.match(second.structuredContent.trace_error, /^trace\.json: ENOSPC/);

  // A send that is traced says nothing of it.
  const { sender: fine } = await pair(t, fake);
  fake.failNext(429);
  const traced = await failed(() => fine.send("receiver", { text: "turned away, and traced" }));
  assert.deepEqual([traced.status, "trace_error" in stopFields(traced)], [429, false]);
});

test("on the command line, against a service that answers: a send turned away says the trace that could not be written, and so does its retry", async (t) => {
  const fake = new FakeAamio({ now: Math.floor(Date.now() / 1000) });
  const { sender, receiver, homeB } = await pair(t, fake);
  await sender.close();
  const { cli } = await serveFake(t, fake);
  // A folder where the trace should be: the file can be neither read nor replaced.
  await rm(join(homeB, "trace.json"), { force: true });
  await mkdir(join(homeB, "trace.json"));
  fake.failNext(429);
  const refused = await cli(homeB, "send", "receiver", "turned away, and untraced");
  assert.equal(refused.status, 1, refused.stderr);
  const told = JSON.parse(refused.stdout);
  assert.deepEqual([told.error_code, told.status, told.outcome, told.retryable], ["send_failed", 429, "refused", true]);
  assert.match(told.trace_error, /^trace\.json: /);
  assert.match(told.fix, /declined this for now/);

  const again = await cli(homeB, "outbox", "retry", "--id", told.message_id);
  assert.equal(again.status, 0, again.stderr);
  const [row] = JSON.parse(again.stdout).retried;
  assert.deepEqual([row.id, row.status, row.http], [told.message_id, "delivered", 201]);
  assert.match(row.trace_error, /^trace\.json: /);
  assert.deepEqual((await receiver.read()).map((m) => [m.body.text, m.replay]), [["turned away, and untraced", false]]);
});
