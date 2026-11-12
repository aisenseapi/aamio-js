// Stage 4 of the Node plan (code/php/docs/aamio-node-funksjonsplan-2026-11-10.md): named channels, and the handover
// of a channel's address to whoever is to write there. Against the fake aamio in memory. The same over the real
// service, with aamio-python and aamio-php on the other side, is in code/php/tools/check-node-exchange.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { GateStop, Keys, keyHash, threadSigningInput } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { serveMcp } from "../src/node-mcp.js";
import { NodeRuntime, checkChannelTtl, checkGate, checkLabel, stopFields } from "../src/node-runtime.js";
import { BOARD, FakeAamio } from "./fake-aamio.mjs";
import { serveFake } from "./serve-fake.mjs";

const HOST = "https://fake.aamio";
const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));

async function fixture(t, fake, ...names) {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-stage4-channels-"));
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

/** Two homes that are each other's partners, each with its inbox open and online: owner in a, guest in b. */
async function pair(t, fake) {
  const { a: homeA, b: homeB, open, root } = await fixture(t, fake, "a", "b");
  const owner = await open(homeA);
  const guest = await open(homeB);
  await owner.partnerAdd("guest", guest.keys.public);
  await guest.partnerAdd("owner", owner.keys.public);
  await owner.read();
  await guest.read();
  return { owner, guest, homeA, homeB, open, root };
}

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
const opens = (fake) => fake.requests.filter((line) => /^PUT \/[a-z2-7]{20}$/.test(line)).length;
const sends = (fake) => fake.requests.filter((line) => /^POST \/[a-z2-7]{20}$/.test(line)).length;
const labels = (runtime) => runtime.state.channels.map((channel) => channel.label);
const failed = async (act) => {
  try {
    await act();
  } catch (error) {
    return error;
  }
  return null;
};

async function call(runtime, name, args) {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const request = { jsonrpc: "2.0", id: 1, method: name === "tools/list" ? name : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } };
  await serveMcp({ home: runtime.home, version: "test", runtime, input: Readable.from([JSON.stringify(request) + "\n"]), output });
  const answer = JSON.parse(text.trim());
  return answer.error ? answer : answer.result;
}

// ------------------------------------------------------------------ what a channel may be

test("a channel's label is a file's name and not the runtime's own, a gate has a shape, and a lifetime its bounds", () => {
  for (const label of ["tender", "tender-2026.Q4", "a", "With_under-score.1", "x".repeat(64), "inb", "boar"]) checkLabel(label);
  for (const label of ["", " ", "a b", "../x", "..", "a/b", "a\\b", "with:colon", ".hidden", "trailing.", "x".repeat(65), "con", "NUL", "com1.txt", "ünïcode", "new\nline", 7, null, undefined, ["tender"]]) {
    assert.throws(() => checkLabel(label), { code: "invalid_label", message: /a channel's label is 1 to 64 letters/ }, JSON.stringify(label));
  }
  // The runtime's own channels: the inbox, the board inbox, and the generations of each.
  for (const label of ["inbox", "inbox-1800000000", "Inbox2", "board", "BOARD-x", "boardroom"]) {
    assert.throws(() => checkLabel(label), { code: "invalid_label", message: /starts with inbox or board/ }, label);
  }
  for (const gate of [{ require: { pow: { bits: 20 } } }, { advise: { pow: { bits: 12 } } }, { require: { per_key: 5 }, advise: {} }]) assert.equal(checkGate(gate), gate);
  for (const [gate, why] of [[{}, /an empty gate asks for nothing/], [[], /a gate must be an object, not a list/], [null, /not null/], ["pow", /not string/], [{ pow: { bits: 20 } }, /a gate has no field pow/],
    [{ require: { pow: { bits: 20 } }, zeta: 1, alpha: 2 }, /a gate has no field alpha, zeta/], [{ require: 20 }, /gate\.require must be an object/], [{ advise: [] }, /gate\.advise must be an object/]]) {
    assert.throws(() => checkGate(gate), (error) => error.code === "invalid_gate" && why.test(error.message) && /A gate is an object with "require", "advise" or both/.test(error.message), JSON.stringify(gate));
  }
  for (const ttl of [30, 600, 3600]) assert.equal(checkChannelTtl(ttl), ttl);
  for (const ttl of [0, 29, 3601, 60.5, "600", null, undefined, Number.NaN]) assert.throws(() => checkChannelTtl(ttl), { code: "invalid_ttl" }, String(ttl));
});

// ------------------------------------------------------------------ opened, listed, read, closed

test("a channel is opened for the partners it names, read with the other channels, listed without its read key, and closed", async (t) => {
  const fake = new FakeAamio();
  const { owner, guest, homeA, open } = await pair(t, fake);
  const opened = await owner.channelOpen("tender", { ttl: 900, allow: ["guest"] });
  assert.deepEqual(Object.keys(opened), ["label", "w", "expire_at", "allow", "gate"]);
  assert.deepEqual([opened.label, opened.expire_at, opened.allow, opened.gate], ["tender", fake.time + 900, ["guest"], null]);
  assert.deepEqual(fake.threads.get(opened.w).allow, [guest.keys.public], "the service holds the list: the partner's key and no other");
  // Kept where the next process finds it, as the other channels are, in the shape the other runtimes keep.
  const kept = (await onDisk(homeA, "state.json")).channels.find((channel) => channel.label === "tender");
  assert.deepEqual(Object.keys(kept), ["label", "read_key", "w", "expire_at", "allow", "after", "created_at", "instance", "gone", "muted", "seen", "seen_from"]);
  assert.deepEqual([kept.w, kept.expire_at, kept.allow, kept.after], [opened.w, opened.expire_at, [guest.keys.public], 0]);

  // What is written there comes with a read, under the channel's label.
  guest.state.peers[opened.w] = owner.keys.public;
  await guest.send(opened.w, { text: "an offer, on the channel" });
  await guest.send("owner", { text: "and a line on the inbox" });
  const got = await owner.read();
  assert.deepEqual(got.map((m) => [m.channel, m.body.text, m.sender]), [["inbox", "and a line on the inbox", "guest"], ["tender", "an offer, on the channel", "guest"]]);
  // A key that is not on the list is turned away by the service.
  const stranger = Keys.generate();
  const refused = await fake.fetch(`${HOST}/${opened.w}`, { method: "POST", body: "not for me", headers: { "X-Key": stranger.public, "X-Sig": stranger.sign(threadSigningInput(opened.w, "not for me")) } });
  assert.equal(refused.status, 403);

  // Listed: the address, the time left, who may write and how far it is read. Never the key that reads it.
  const list = owner.channelList();
  assert.deepEqual(list.map((channel) => channel.label), ["inbox", "tender"]);
  const shown = list[1];
  assert.deepEqual(shown, { label: "tender", w: opened.w, expire_at: opened.expire_at, seconds_left: 900, expired: false, allow: ["guest"], received: 1, read_to: 1, gone: false, muted: false });
  assert.ok(!JSON.stringify(list).includes(kept.read_key) && !JSON.stringify(opened).includes(kept.read_key));
  // A process of its own has read nothing, and still says how far the channel is read.
  await owner.close();
  let again = await open(homeA);
  assert.deepEqual(again.channelList()[1], { ...shown, received: 0 });
  fake.time += 100;
  assert.equal(again.channelList()[1].seconds_left, 800);
  // The receipt of the channel is taken by its label.
  assert.equal((await again.receipt("tender")).count, 1);

  // Closed: gone at the service for everyone who holds the address, and out of this home.
  const closed = await again.channelClose("tender");
  assert.deepEqual(closed, { label: "tender", w: opened.w, status: 200, deleted: true, closed_here: true });
  assert.equal(fake.threads.has(opened.w), false);
  assert.deepEqual(labels(again), ["inbox"]);
  assert.deepEqual((await onDisk(homeA, "state.json")).channels.map((channel) => channel.label), ["inbox"]);
  // A second time there is no such channel, and the answer says which there are.
  const twice = await failed(() => again.channelClose("tender"));
  assert.equal(twice.code, "unknown_channel");
  assert.match(twice.message, /no channel called tender in this home\. It has inbox\./);
  await again.close();
  again = await open(homeA);
  assert.deepEqual(labels(again), ["inbox"]);
});

test("what cannot be a channel is refused before anything is opened", async (t) => {
  const fake = new FakeAamio();
  const { owner } = await pair(t, fake);
  await owner.channelOpen("tender", { ttl: 600 });
  const before = [opens(fake), sends(fake), labels(owner).join()];
  for (const [args, code, why] of [
    [["../../notes", {}], "invalid_label", /a channel's label is 1 to 64 letters/],
    [["inbox-2", {}], "invalid_label", /starts with inbox or board/],
    [["board", {}], "invalid_label", /starts with inbox or board/],
    [["tender", {}], "channel_exists", /there is a channel called tender already/],
    // Apart from upper and lower case too: the two would be one file in the archive where the file system says so.
    [["TENDER", {}], "channel_exists", /there is a channel called tender already/],
    [["short", { ttl: 10 }], "invalid_ttl", /from 30 to 3600/],
    [["long", { ttl: 7200 }], "invalid_ttl", /from 30 to 3600/],
    [["nobody", { allow: ["someone"] }], "unknown_partner", /unknown partner: someone/],
    [["noted", { note: "moving the tender here" }], "invalid_note", /note travels with the address to whoever to names/],
    [["gated", { gate: { pow: 20 } }], "invalid_gate", /a gate has no field pow/],
    [["handed", { to: "someone" }], "unknown_partner", /unknown partner: someone/],
    [["handed", { to: "a".repeat(20) }], "unknown_address", /no key known for address/],
  ]) {
    const refused = await failed(() => owner.channelOpen(...args));
    assert.equal(refused?.code, code, JSON.stringify(args));
    assert.match(refused.message, why);
  }
  assert.deepEqual([opens(fake), sends(fake), labels(owner).join()], before, "nothing was opened, nothing was sent, and the home is as it was");
});

test("a gate is set when the channel is opened, in the same request, and one the service does not take opens nothing", async (t) => {
  const fake = new FakeAamio();
  const { owner, guest } = await pair(t, fake);
  const gate = { require: { per_key: 5 }, advise: { pow: { bits: 4 } } };
  const opened = await owner.channelOpen("gated", { ttl: 600, allow: ["guest"], gate });
  assert.deepEqual(opened.gate, gate, "the gate is in the answer, as it was asked for");
  assert.deepEqual(fake.threads.get(opened.w).gate, gate, "and the thread holds it, from the request that opened it");
  // Whoever writes reads the gate and does the work it advises.
  guest.state.peers[opened.w] = owner.keys.public;
  const sent = await guest.send(opened.w, { text: "with the work the gate advises" });
  assert.equal(sent.seq, 1);
  assert.deepEqual((await owner.read()).map((m) => [m.channel, m.body.text]), [["gated", "with the work the gate advises"]]);
  // A channel without one says so too: gate null, and nothing kept of it here.
  assert.equal((await owner.channelOpen("plain", { ttl: 600 })).gate, null);
  assert.ok(owner.state.channels.every((channel) => !("gate" in channel)));

  fake.refuseGate = true;
  const before = labels(owner).join();
  const refused = await failed(() => owner.channelOpen("too-much", { ttl: 600, gate: { require: { pow: { bits: 99 } } } }));
  assert.equal(refused.code, "channel_unavailable");
  assert.match(refused.message, /could not open channel: 400 the gate asks for what this service does not take\. Nothing was opened\./);
  assert.equal(labels(owner).join(), before);
});

// ------------------------------------------------------------------ handed over

test("with to, the address goes sealed and signed to who is to write there, and their runtime can then send to it", async (t) => {
  const fake = new FakeAamio();
  const { owner, guest, homeA, homeB } = await pair(t, fake);
  const opened = await owner.channelOpen("tender", { ttl: 900, to: "guest", note: "moving the tender here" });
  assert.deepEqual([opened.handed_to, opened.address_sent_to, opened.allow, typeof opened.message_id], ["guest", guest.channel("inbox").w, ["guest"], "string"]);
  assert.deepEqual(fake.threads.get(opened.w).allow, [guest.keys.public], "the key the address went to may write there");
  // Through the outbox, as a send goes: the same bytes can go again, and the trace has it.
  assert.equal(owner.outbox[opened.message_id].status, "delivered");
  assert.deepEqual((await onDisk(homeA, "outbox.json"))[opened.message_id].summary, { channel: opened.w });
  assert.deepEqual(owner.trace("guest").sent.map((row) => [row.message_id, row.fields]), [[opened.message_id, ["channel", "expire_at", "text"]]]);

  // The guest reads it: verified, sealed, with the address, when it closes and the line that came with it.
  const [invitation] = await guest.read();
  assert.deepEqual([invitation.sender, invitation.verified, invitation.encrypted, invitation.body], ["owner", true, true, { channel: opened.w, expire_at: opened.expire_at, text: "moving the tender here" }]);
  // Which is what binds the address to the owner's key, in the guest's home, for this process and the next.
  assert.equal((await onDisk(homeB, "state.json")).peers[opened.w], owner.keys.public);
  const sent = await guest.send(opened.w, { text: "our offer" });
  assert.equal(sent.w, opened.w);
  assert.deepEqual((await owner.read()).map((m) => [m.channel, m.sender, m.body.text]), [["tender", "guest", "our offer"]]);

  // The partners named in allow write there too, beside the one the address went to.
  const third = Keys.generate();
  await owner.partnerAdd("third", third.public);
  await guest.read();
  const shared = await owner.channelOpen("shared", { ttl: 600, allow: ["third"], to: guest.keys.public });
  assert.deepEqual([shared.allow, fake.threads.get(shared.w).allow], [["third", "guest"], [third.public, guest.keys.public]]);

  // An address a verified message gave as reply_to takes one as well: sealed to the key that address is bound to.
  const reply = (await guest.read()).at(-1);
  await guest.send("owner", { text: "write to me here" });
  const [asked] = await owner.read();
  const answered = await owner.channelOpen("answer", { ttl: 600, to: asked.body.reply_to });
  assert.deepEqual([answered.handed_to, answered.address_sent_to], ["guest", guest.channel("inbox").w]);
  assert.deepEqual((await guest.read()).map((m) => m.body.channel), [answered.w]);
  void reply;
});

test("what would stop the handover is found before the channel is opened, and leaves none behind", async (t) => {
  const fake = new FakeAamio();
  const { owner, guest } = await pair(t, fake);
  const before = () => [opens(fake), sends(fake), labels(owner).join(), Object.keys(owner.outbox).length];
  const start = before();

  // The inbox the address would go to asks for what this client cannot do.
  fake.gates.set(guest.channel("inbox").w, { require: { captcha: { kind: "image" } } });
  const stopped = await failed(() => owner.channelOpen("gated-away", { ttl: 600, to: "guest" }));
  assert.ok(stopped instanceof GateStop);
  assert.match(stopped.reason, /This inbox requires captcha, a condition this client does not know how to meet/);
  assert.equal(stopped.opened, undefined, "nothing is open");
  fake.gates.delete(guest.channel("inbox").w);
  owner.client.forgetGate(guest.channel("inbox").w);

  // A note that would not fit in the message that carries the address.
  const long = await failed(() => owner.channelOpen("too-long", { ttl: 600, to: "guest", note: "x".repeat(70_000) }));
  assert.equal(long.code, "too_large");
  assert.match(long.message, /^with this note the message carrying the address would be \d+ bytes, and a message is at most 65536, so no channel was opened\./);

  // A partner who is not online: there is nowhere to send the address.
  fake.presence.clear();
  const away = await failed(() => owner.channelOpen("offline", { ttl: 600, to: "guest" }));
  assert.equal(away.code, "partner_offline");
  assert.deepEqual(before(), start, "no channel was opened for any of them, and nothing was sent");
});

test("a channel that cannot be written down is closed again and handed to nobody", async (t) => {
  const fake = new FakeAamio();
  const { owner, guest, homeA } = await pair(t, fake);
  const threads = fake.threads.size;
  // The lookup of the partner writes the state once. The write that would hold the channel is the next.
  const real = owner.saveJson.bind(owner);
  let saves = 0;
  owner.saveJson = async (name, value) => {
    if (name === "state.json" && ++saves === 2) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return real(name, value);
  };
  const unsaved = await failed(() => owner.channelOpen("tender", { ttl: 600, to: "guest" }));
  assert.equal(unsaved.code, "not_saved");
  assert.equal(unsaved.message, "the channel could not be written down (ENOSPC), so it is not used and its address was given to nobody. It was closed again at the service.");
  assert.equal(fake.threads.size, threads, "the thread that was opened is gone at the service");
  assert.deepEqual([labels(owner), (await onDisk(homeA, "state.json")).channels.map((channel) => channel.label), Object.keys(owner.outbox)], [["inbox"], ["inbox"], []]);
  assert.deepEqual(await guest.read(), [], "and no address went to anyone");

  // When it cannot be closed either, the answer says that it stays, unread, and until when.
  owner.saveJson = async (name, value) => {
    if (name === "state.json") throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return real(name, value);
  };
  fake.closeFailures.push("network");
  const stuck = await failed(() => owner.channelOpen("tender", { ttl: 600 }));
  assert.match(stuck.message, new RegExp(`It could not be closed at the service either, and stays there, unread, until ${fake.time + 600}\\.$`));
  assert.deepEqual(labels(owner), ["inbox"]);
});

test("when the address does not get through, the channel is open all the same and the answer says so, with what is known of the send", async (t) => {
  const fake = new FakeAamio();
  const { owner, guest } = await pair(t, fake);
  const inbox = guest.channel("inbox").w;

  // Stored, and the answer lost: it may have arrived. The same bytes go again from the outbox.
  fake.failNext("lost");
  const lost = await failed(() => owner.channelOpen("lost", { ttl: 600, to: "guest" }));
  assert.deepEqual([lost.code, lost.outcome, lost.status, lost.retryable], ["send_failed", "unknown", 0, null]);
  assert.deepEqual(Object.keys(lost.opened), ["label", "w", "expire_at"]);
  assert.deepEqual([lost.opened.label, labels(owner).includes("lost"), fake.threads.has(lost.opened.w)], ["lost", true, true]);
  assert.match(lost.message, /^the channel lost is open, and the message carrying its address did not land: send unknown \(http 0\)/);
  assert.match(lost.fix, /^The channel lost is open and listed by channel list, aamio_channels over MCP: only the message carrying its address did not go\. No answer came back, so this message may already have been delivered\./);
  assert.deepEqual(stopFields(lost).opened, lost.opened);
  const [row] = await owner.outboxRetry(lost.message_id);
  assert.deepEqual([row.status, row.http], ["delivered", 201]);
  assert.deepEqual((await guest.read()).map((m) => [m.body.channel, m.replay]), [[lost.opened.w, false], [lost.opened.w, true]], "the address arrived once, and the copy is marked");

  // Turned away: nothing was stored, and the answer says that this refusal will be repeated.
  fake.failNext(403);
  const refused = await failed(() => owner.channelOpen("refused", { ttl: 600, to: "guest" }));
  assert.deepEqual([refused.outcome, refused.status, refused.retryable, refused.opened.label], ["refused", 403, false, "refused"]);
  assert.match(refused.fix, /only the message carrying its address did not go\. aamio refused this and will refuse the same bytes again/);

  // Not written to the outbox: nothing left this machine, and nobody has the address.
  const before = sends(fake);
  failSaving(owner, "outbox.json");
  const unsent = await failed(() => owner.channelOpen("unsent", { ttl: 600, to: "guest" }));
  assert.deepEqual([unsent.code, unsent.outcome, unsent.status, unsent.retryable, unsent.opened.label], ["send_failed", "never_sent", 0, false, "unsent"]);
  assert.match(unsent.message, /^the channel unsent is open, and the message carrying its address was not sent: /);
  assert.match(unsent.fix, /^Nothing left this machine, so nobody has been given the address of unsent\. Close it with channel close unsent/);
  assert.equal(sends(fake), before);

  // Stopped at the gate when the message was to go, after the channel was opened: the stop carries the channel.
  const realDeliver = owner.deliver.bind(owner);
  owner.deliver = async () => {
    throw new GateStop("The proof of work of 20 bits was not done before the inbox stops taking writes, so the work was stopped and nothing was sent.", "Ask the owner for a longer inbox.");
  };
  const gated = await failed(() => owner.channelOpen("gated", { ttl: 600, to: inbox }));
  owner.deliver = realDeliver;
  assert.ok(gated instanceof GateStop);
  assert.deepEqual([gated.opened.label, labels(owner).includes("gated")], ["gated", true]);
  assert.match(gated.fix, /^The channel gated is open and listed by channel list, aamio_channels over MCP: only the message carrying its address did not go\. Ask the owner for a longer inbox\.$/);

  // Every one of them is there to be closed, or handed over again by another way.
  assert.deepEqual(labels(owner), ["inbox", "lost", "refused", "unsent", "gated"]);
  for (const label of ["lost", "refused", "unsent", "gated"]) assert.equal((await owner.channelClose(label)).closed_here, true);
});

test("a channel leaves this home when the service says its thread is gone, and stays when it does not say", async (t) => {
  const fake = new FakeAamio();
  const { owner, guest, homeA } = await pair(t, fake);
  const opened = await owner.channelOpen("tender", { ttl: 600, allow: ["guest"] });
  guest.state.peers[opened.w] = owner.keys.public;

  // No answer, and then a refusal: whether the thread is gone is not known, so the channel is kept and still read.
  for (const [failure, status, words] of [["network", 0, /^The service did not answer, so the thread may still be there, and the channel is kept and still read\./], [500, 500, /^The service answered 500, so the thread may still be there/]]) {
    fake.closeFailures.push(failure);
    const kept = await owner.channelClose("tender");
    assert.deepEqual([kept.status, kept.deleted, kept.closed_here], [status, false, false]);
    assert.match(kept.note, words);
    assert.match(kept.note, new RegExp(`Close it again, or let it expire at ${opened.expire_at}\\.$`));
  }
  assert.deepEqual(labels(owner), ["inbox", "tender"]);
  await guest.send(opened.w, { text: "written while the close was unsettled" });
  assert.deepEqual((await owner.read()).map((m) => m.body.text), ["written while the close was unsettled"], "what is written there meanwhile is read, not lost");

  // Deleted at the service, and the home could not be written: it still lists the channel, and says why.
  failSaving(owner, "state.json");
  const unsaved = await failed(() => owner.channelClose("tender"));
  assert.deepEqual([unsaved.code, unsaved.status, unsaved.deleted], ["not_saved", 200, true]);
  assert.match(unsaved.message, /^the thread is deleted at the service, and state\.json could not be written \(ENOSPC\), so this home still lists tender\. Close it again/);
  assert.deepEqual([labels(owner), (await onDisk(homeA, "state.json")).channels.map((channel) => channel.label)], [["inbox", "tender"], ["inbox", "tender"]]);
  // Closed again: the service has no thread there any more, which is what was wanted, and the channel leaves the home.
  const again = await owner.channelClose("tender");
  assert.deepEqual([again.status, again.deleted, again.closed_here], [404, false, true]);
  assert.match(again.note, /^There was no thread at this address any more/);
  assert.deepEqual([labels(owner), (await onDisk(homeA, "state.json")).channels.map((channel) => channel.label)], [["inbox"], ["inbox"]]);
  // The inbox can be closed too: the next read opens a new one for the partners.
  assert.equal((await owner.channelClose("inbox")).deleted, true);
  await owner.read();
  assert.deepEqual(labels(owner), ["inbox"]);
});

test("a channel for one key leaves the open board inbox behind: only that key writes there, and its address goes where the answer said", async (t) => {
  const fake = new FakeAamio();
  const { a: homeA, b: homeB, open } = await fixture(t, fake, "a", "b");
  const poster = await open(homeA);
  const answerer = await open(homeB);
  const posted = await poster.boardPost({ kind: "need", title: "a need", text: "who can help?" });
  await answerer.boardAnswer(posted.post.id, { text: "I can" });
  const [answer] = await poster.read();
  assert.deepEqual([answer.channel, answer.sender, answer.verified], ["board", "unknown key", true]);

  // By the key that signed the answer, to the address the answer gave: a stranger, and no partner is needed.
  const opened = await poster.channelOpenWith(answer.from_key, { ttl: 900, replyTo: answer.body.reply_to, note: "let us go on here" });
  const label = `with-${keyHash(answerer.keys.public).slice(0, 8)}`;
  assert.deepEqual([opened.label, opened.with, opened.address_sent_to, opened.expire_at, typeof opened.message_id], [label, answerer.keys.public, answer.body.reply_to, fake.time + 900, "string"]);
  assert.deepEqual(fake.threads.get(opened.w).allow, [answerer.keys.public], "only that key may write there");
  const [invitation] = await answerer.read();
  assert.deepEqual([invitation.channel, invitation.verified, invitation.encrypted, invitation.body.channel, invitation.body.text], ["board", true, true, opened.w, "let us go on here"]);
  await answerer.send(opened.w, { text: "in private now" });
  assert.deepEqual((await poster.read()).map((m) => [m.channel, m.body.text]), [[label, "in private now"]]);

  // A second channel for the same key takes a label of its own. Without an address to send it to, it is only opened.
  const second = await poster.channelOpenWith(answerer.keys.public);
  assert.match(second.label, new RegExp(`^${label}-\\d+$`));
  assert.deepEqual([second.address_sent_to, "message_id" in second], [null, false]);
  // By name, for a partner.
  await poster.partnerAdd("helper", answerer.keys.public);
  const named = await poster.channelOpenWith("helper", { label: "with-helper" });
  assert.deepEqual([named.label, named.with], ["with-helper", "helper"]);

  const before = [opens(fake), labels(poster).join()];
  const other = Keys.generate().public;
  for (const [args, code, why] of [
    [["nobody"], "unknown_partner", /not a key and not a known partner: nobody/],
    [[answerer.keys.public, { note: "a line with nowhere to go" }], "invalid_note", /without reply-to there is nothing to carry it/],
    [[answerer.keys.public, { replyTo: "not an address" }], "invalid_address", /reply-to is a write address/],
    // The address is known here as another key's: the channel's address would be sealed to a key that does not read there.
    [[other, { replyTo: answer.body.reply_to }], "binding_conflict", /is bound to helper, and this channel is for another key/],
    [[answerer.keys.public, { label: "with-helper" }], "channel_exists", /there is a channel called with-helper already/],
    [[answerer.keys.public, { label: "inbox-x" }], "invalid_label", /starts with inbox or board/],
    [[answerer.keys.public, { ttl: 5 }], "invalid_ttl", /from 30 to 3600/],
  ]) {
    const refused = await failed(() => poster.channelOpenWith(...args));
    assert.equal(refused?.code, code, JSON.stringify(args));
    assert.match(refused.message, why);
  }
  assert.deepEqual([opens(fake), labels(poster).join()], before);
});

// ------------------------------------------------------------------ over the local server, and on the command line

test("over MCP: a channel is opened, handed over, listed and closed, and what goes wrong says which channel is open", async (t) => {
  const fake = new FakeAamio();
  const { owner, guest } = await pair(t, fake);
  const tools = (await call(owner, "tools/list")).tools;
  assert.equal(tools.length, 24);
  for (const name of ["aamio_open_channel", "aamio_channels", "aamio_close_channel"]) assert.ok(tools.some((tool) => tool.name === name), name);
  const schema = tools.find((tool) => tool.name === "aamio_open_channel").inputSchema;
  assert.deepEqual([schema.required, Object.keys(schema.properties)], [["label", "ttl"], ["label", "ttl", "allow", "to", "note", "gate"]]);

  const opened = await call(owner, "aamio_open_channel", { label: "tender", ttl: 600, to: "guest", note: "moving the tender here", gate: { require: { per_key: 9 } } });
  assert.equal(opened.isError, false, JSON.stringify(opened));
  assert.deepEqual([opened.structuredContent.handed_to, opened.structuredContent.gate, opened.structuredContent.allow], ["guest", { require: { per_key: 9 } }, ["guest"]]);
  const list = (await call(owner, "aamio_channels", {})).structuredContent.channels;
  assert.deepEqual(list.map((channel) => [channel.label, channel.w === opened.structuredContent.w]), [["inbox", false], ["tender", true]]);
  assert.ok(!JSON.stringify(list).includes(owner.channel("tender").read_key), "no read key is ever listed");
  assert.deepEqual((await call(guest, "aamio_read", {})).structuredContent.messages.map((m) => m.body.channel), [opened.structuredContent.w]);

  // A wrong gate is a refusal with the shape it should have had, not a channel that is open without it.
  const wrong = await call(owner, "aamio_open_channel", { label: "gated", ttl: 600, gate: { pow: { bits: 20 } } });
  assert.deepEqual([wrong.isError, wrong.structuredContent.error_code, wrong.structuredContent.given], [true, "invalid_gate", { pow: { bits: 20 } }]);
  assert.match(wrong.structuredContent.fix, /^Send a gate with require, advise or both/);
  // The address did not get through: the channel is open, and the answer carries it.
  fake.failNext("lost");
  const lost = await call(owner, "aamio_open_channel", { label: "lost", ttl: 600, to: "guest" });
  assert.deepEqual([lost.isError, lost.structuredContent.error_code, lost.structuredContent.operation, lost.structuredContent.outcome, lost.structuredContent.opened.label], [true, "send_failed", "open_channel", "unknown", "lost"]);
  assert.match(lost.structuredContent.fix, /^The channel lost is open/);
  for (const [args, code] of [[{ label: "inbox-2", ttl: 600 }, "invalid_label"], [{ label: "tender", ttl: 600 }, "channel_exists"], [{ label: "noted", ttl: 600, note: "nowhere to go" }, "invalid_note"], [{ label: "nobody", ttl: 600, allow: ["someone"] }, "unknown_partner"]]) {
    const refused = await call(owner, "aamio_open_channel", args);
    assert.deepEqual([refused.isError, refused.structuredContent.error_code], [true, code], JSON.stringify(args));
  }
  for (const args of [{ label: "x" }, { ttl: 600 }, { label: "x", ttl: 10 }, { label: "x", ttl: 4000 }, { label: "x", ttl: 600, allow: "guest" }, { label: "x", ttl: 600, gate: "pow" }, { label: "x", ttl: 600, extra: 1 }]) {
    assert.equal((await call(owner, "aamio_open_channel", args)).error?.code, -32602, JSON.stringify(args));
  }

  const closed = await call(owner, "aamio_close_channel", { label: "tender" });
  assert.deepEqual([closed.isError, closed.structuredContent.deleted, closed.structuredContent.closed_here], [false, true, true]);
  const twice = await call(owner, "aamio_close_channel", { label: "tender" });
  assert.deepEqual([twice.isError, twice.structuredContent.error_code], [true, "unknown_channel"]);
  fake.closeFailures.push("network");
  const kept = await call(owner, "aamio_close_channel", { label: "lost" });
  assert.deepEqual([kept.isError, kept.structuredContent.closed_here, kept.structuredContent.status], [false, false, 0]);
});

test("on the command line: a channel is opened, listed and closed, and one for a key is handed over from the board", async (t) => {
  const fake = new FakeAamio({ now: Math.floor(Date.now() / 1000) });
  const { owner, guest, homeA, homeB } = await pair(t, fake);
  await owner.close();
  await guest.close();
  const { cli } = await serveFake(t, fake);
  const said = (run) => {
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  const opened = said(await cli(homeA, "channel", "open", "tender", "--ttl", "900", "--allow", "guest", "--gate", JSON.stringify({ require: { per_key: 3 } })));
  assert.deepEqual([opened.label, opened.allow, opened.gate], ["tender", ["guest"], { require: { per_key: 3 } }]);
  const list = said(await cli(homeA, "channel", "list")).channels;
  assert.deepEqual(list.map((channel) => [channel.label, channel.expired, channel.read_to]), [["inbox", false, 0], ["tender", false, 0]]);
  assert.ok(!JSON.stringify([opened, list]).includes((await onDisk(homeA, "state.json")).channels[1].read_key));

  // A channel for the guest's key, with its address sent to the guest's inbox, as after an answer on the board.
  const inbox = (await onDisk(homeB, "state.json")).channels[0].w;
  const whoami = said(await cli(homeB, "whoami"));
  const forOne = said(await cli(homeA, "board", "channel", whoami.key, "--reply-to", inbox, "--note", "let us go on here"));
  assert.deepEqual([forOne.label, forOne.with, forOne.address_sent_to], [`with-${whoami.hash_prefix}`, "guest", inbox]);
  const read = said(await cli(homeB, "read"));
  assert.deepEqual(read.messages.map((m) => [m.body.channel, m.body.text, m.archived]), [[forOne.w, "let us go on here", true]]);
  said(await cli(homeB, "send", forOne.w, "on the channel"));
  assert.deepEqual(said(await cli(homeA, "read")).messages.map((m) => [m.channel, m.body.text]), [[forOne.label, "on the channel"]]);

  const closed = said(await cli(homeA, "channel", "close", "tender"));
  assert.deepEqual([closed.deleted, closed.closed_here], [true, true]);
  const twice = await cli(homeA, "channel", "close", "tender");
  assert.deepEqual([twice.status, twice.stdout], [1, ""]);
  assert.match(twice.stderr, /no channel called tender in this home/);
  const taken = await cli(homeA, "channel", "open", forOne.label);
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /there is a channel called with-[0-9a-f]{8} already/);
});

test("on the command line: what can be seen to be wrong about a channel is refused before the home is opened or made", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aamio-node-stage4-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unused = join(root, "never-made");
  const key = Keys.generate().public;
  const wrong = [
    ["channel"], ["channel", "nothing"], ["channel", "open"], ["channel", "open", "../../notes"], ["channel", "open", "inbox-2"], ["channel", "open", "board"], ["channel", "open", "a", "b"],
    ["channel", "open", "tender", "--ttl", "10"], ["channel", "open", "tender", "--ttl", "4000"], ["channel", "open", "tender", "--gate", "{not json"], ["channel", "open", "tender", "--gate", "{}"],
    ["channel", "open", "tender", "--gate", "{\"pow\":20}"], ["channel", "open", "tender", "--to", "guest"], ["channel", "list", "extra"], ["channel", "close"], ["channel", "close", "a", "b"],
    ["board", "channel"], ["board", "channel", key, "--reply-to", "not an address"], ["board", "channel", key, "--note", "nowhere to go"], ["board", "channel", key, "--ttl", "0"],
    ["board", "replies", "extra"], ["board", "replies", "--wait", "60"], ["board", "replies", "--post", ""],
    ["archive", "forever"], ["archive", "days:0"], ["archive", "keep", "--max-mb", "0"], ["archive", "keep", "--max-mb", "many"], ["archive", "status", "--max-mb", "5"], ["archive", "keep", "--all"],
    ["archive", "status", "--all"], ["archive", "keep", "off"],
  ];
  for (const args of wrong) {
    const refused = spawnSync(process.execPath, [bin, "--home", unused, ...args], { encoding: "utf8", timeout: 30_000, env: { ...process.env, AAMIO_HOST: "http://127.0.0.1:9", AAMIO_BOARD: "http://127.0.0.1:9" } });
    assert.equal(refused.status, 2, `${args.join(" ")}: ${refused.stderr}`);
    assert.equal(refused.stdout, "");
  }
  assert.equal(existsSync(unused), false);
  assert.deepEqual(await readdir(root), []);
});
