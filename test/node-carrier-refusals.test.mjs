// What a carrier refuses is said where the user sees it, and never answered over the medium.
//
// Contract 3, A7: refusals stay with the receiver, and are logged and shown there. Until 22 November 2026 every refusal
// went into a list that only tests read, also a message refused because the session it came in had expired with a
// restart, so that it was not stored (A6.8). A refusal from a verified sender is said once for each partner, session and
// code, one in an expired session goes to attention, and what was turned away before a sender was known is counted and
// said at most once a minute, since anyone in range can send it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keys } from "../src/aamio.js";
import * as carry from "../src/carry.js";
import { Carrier, REFUSALS_KEPT } from "../src/node-carrier.js";
import { CarryState, profile } from "../src/node-carry-state.js";
import { initIdentity } from "../src/node-identity.js";
import { NodeRuntime } from "../src/node-runtime.js";

const parties = JSON.parse(readFileSync(new URL("./carry_v1_vectors.json", import.meta.url), "utf8")).parties;
const keys = (name) => Keys.fromSeedHex(parties[name].seed);
const unhex = (text) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const pk = (name) => unhex(parties[name].pk);
const same = (one, other) => one.length === other.length && one.every((byte, index) => byte === other[index]);
const PROFILE = profile({ mode: "sealed" });
const NOW = 1_794_700_000;

// What a carrier asks of its transport, with frames handed to it as if they had been heard. Nothing goes out.
class Medium {
  name = "stub";
  properties = { max_frame_up: 4096, max_frame_down: 4096 };
  heard = [];

  async poll() {
    const heard = this.heard;
    this.heard = [];
    return heard.map((frame) => ["received", null, frame]);
  }

  room() { return 0; }
  checkTime() {}
  waitingForRoom() {}
}

function receiver(state, clock) {
  const lines = [];
  const notes = [];
  const medium = new Medium();
  const carrier = new Carrier(state, medium, PROFILE, [pk("A")], {
    clock: () => clock.now, wall: () => NOW, log: (line) => lines.push(line),
    nameOf: (key) => (same(key, pk("A")) ? "alice" : "stranger"),
    attention: (state, text) => notes.push([state, text]),
  });
  return { carrier, medium, lines, notes };
}

async function hear(at, envelope) {
  at.medium.heard.push(...carry.split(envelope, at.medium.properties.max_frame_up));
  await at.carrier.pump(0);
}

// A has asked B for a session and has B's challenge: the open it answers with, and A's state.
function askedAndChallenged() {
  const atA = new CarryState(keys("A"));
  const atB = new CarryState(keys("B"));
  const [session, ask] = atA.ask(pk("B"), PROFILE, 0);
  const [, challenge] = atB.deliver(ask, [pk("A")], PROFILE, 0, NOW);
  const [, opening] = atA.deliver(challenge, [pk("B")], PROFILE, 0, NOW);
  return { atA, atB, session, opening };
}

test("a message in a session that expired with a restart goes to attention once, and nothing is answered", async () => {
  const { atA, atB, session, opening } = askedAndChallenged();
  assert.equal(atB.deliver(opening, [pk("A")], PROFILE, 0, NOW)[0], "accepted");
  atB.restart();
  const at = receiver(atB, { now: 1000 });
  const envelope = atA.send(pk("B"), session, new TextEncoder().encode("hei"), PROFILE);

  await hear(at, envelope);

  assert.deepEqual(at.carrier.refused, ["carry_session_expired"]);
  assert.deepEqual(at.notes.map(([state]) => state), ["session_expired"]);
  const said = at.notes[0][1];
  assert.ok(said.includes("alice") && said.includes("not stored") && said.includes("sent again") && said.includes("A6.8"), said);
  assert.deepEqual(at.carrier.queue, [], "nothing is answered over the medium");
  assert.deepEqual(at.carrier.inbox, [], "and nothing was taken");

  await hear(at, envelope);
  await hear(at, atA.send(pk("B"), session, new TextEncoder().encode("igjen"), PROFILE));

  assert.deepEqual(at.carrier.refused, ["carry_session_expired", "carry_session_expired", "carry_session_expired"]);
  assert.equal(at.notes.length, 1, "a copy, and another message in the same session, are not said again");
});

test("another refusal from a known partner is logged once, with its kind and code", async () => {
  const { atB, opening } = askedAndChallenged();
  atB.restart(); // the challenge that waited goes with the restart (A6.8), so the open matches nothing
  const at = receiver(atB, { now: 1000 });

  await hear(at, opening);
  await hear(at, opening);

  assert.deepEqual(at.carrier.refused, ["carry_nonce_unknown", "carry_nonce_unknown"]);
  const said = at.lines.filter((line) => line.includes("carry_nonce_unknown"));
  assert.equal(said.length, 1, at.lines.join("\n"));
  assert.ok(said[0].includes("an open from alice") && said[0].includes("not answered over the medium") && said[0].includes("transport stub"), said[0]);
  assert.deepEqual(at.notes, []);
  assert.deepEqual(at.carrier.queue, []);
});

test("what was turned away before a sender was known is counted and said at most once a minute", async () => {
  const stranger = new CarryState(keys("C"));
  const clock = { now: 1000 };
  const at = receiver(new CarryState(keys("B")), clock);
  const said = () => at.lines.filter((line) => line.includes("before a sender was known"));

  await hear(at, stranger.ask(pk("B"), PROFILE, 0)[1]);
  assert.deepEqual(said(), ["transport stub: turned away before a sender was known, said at most once a minute: carry_unknown_sender 1"]);

  for (let n = 0; n < 3; n++) await hear(at, stranger.ask(pk("B"), PROFILE, 0)[1]);
  at.medium.heard.push(Uint8Array.of(120));
  await at.carrier.pump(0);
  assert.equal(said().length, 1, "within the minute they are counted, not said");

  clock.now += 61;
  await at.carrier.pump(0);

  assert.equal(said().at(-1), "transport stub: turned away before a sender was known, said at most once a minute: carry_unknown_sender 3, frame_bad_length 1");
  await at.carrier.pump(0);
  assert.equal(said().length, 2, "nothing new, nothing said");
  assert.deepEqual(at.notes, []);
  assert.ok(!at.lines.join(" ").includes("alice"));
});

test("the list of refusal codes keeps only the newest", async () => {
  const at = receiver(new CarryState(keys("B")), { now: 1000 });
  for (let n = 0; n < REFUSALS_KEPT + 5; n++) at.medium.heard.push(Uint8Array.of(120));

  await at.carrier.pump(0);

  assert.deepEqual(at.carrier.refused, Array(REFUSALS_KEPT).fill("frame_bad_length"), "a long aamio serve kept every code for as long as it ran");
  assert.equal(at.lines.filter((line) => line.includes("before a sender was known")).length, 1);
});

test("a refusal said again keeps what another partner said unread, through the coupling a running carrier is given", async (t) => {
  // alice, then carol, then alice in her other session: alice's text waited there already, and in aamio-python and
  // aamio-php it replaced what waited, so carol's was gone before anyone read it (the review of 23 November 2026). Here
  // each waits as a note of its own, and a read takes them once.
  const dir = mkdtempSync(join(tmpdir(), "aamio-refusals-"));
  const home = join(dir, "b");
  await initIdentity(home);
  const runtime = await NodeRuntime.open({ home, host: "http://127.0.0.1:9" });
  t.after(async () => {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await runtime.partnerAdd("alice", keys("A").public);
  await runtime.partnerAdd("carol", keys("C").public);
  const lines = [];
  runtime.log = (line) => lines.push(line);
  const known = [pk("A"), pk("C")];
  const atB = new CarryState(keys("B"));
  const opened = (sender) => {
    const [session, ask] = sender.ask(pk("B"), PROFILE, 0);
    const [, challenge] = atB.deliver(ask, known, PROFILE, 0, NOW);
    const [, opening] = sender.deliver(challenge, [pk("B")], PROFILE, 0, NOW);
    assert.equal(atB.deliver(opening, known, PROFILE, 0, NOW)[0], "accepted");
    return session;
  };
  const atA = new CarryState(keys("A"));
  const atC = new CarryState(keys("C"));
  const [first, second, carols] = [opened(atA), opened(atA), opened(atC)];
  atB.restart();
  const medium = new Medium();
  const carrier = new Carrier(atB, medium, PROFILE, known, {
    clock: () => 1000, wall: () => NOW, log: (line) => lines.push(line),
    nameOf: (key) => (same(key, pk("A")) ? "alice" : "carol"),
    attention: runtime.transportService().attentionFor("stub"),
  });
  const at = { carrier, medium };
  const stub = async () => (await runtime.attentionTaken()).filter((note) => note.channel === "stub");

  await hear(at, atA.send(pk("B"), first, new TextEncoder().encode("1"), PROFILE));
  await hear(at, atC.send(pk("B"), carols, new TextEncoder().encode("2"), PROFILE));
  await hear(at, atA.send(pk("B"), second, new TextEncoder().encode("3"), PROFILE));

  assert.deepEqual(carrier.refused, Array(3).fill("carry_session_expired"));
  const taken = await stub();
  assert.deepEqual(taken.map((note) => note.state), ["session_expired", "session_expired"], JSON.stringify(taken));
  assert.ok(taken[0].what.startsWith("a message from alice") && taken[1].what.startsWith("a message from carol"), JSON.stringify(taken));
  assert.ok(lines.at(-1).startsWith("transport stub: a message from alice"), "the third is in the log: " + lines.join("\n"));
  assert.deepEqual(await stub(), [], "read once, and then gone");

  const third = opened(atA);
  atB.restart();
  await hear(at, atA.send(pk("B"), third, new TextEncoder().encode("4"), PROFILE));
  const again = await stub();
  assert.equal(again.length, 1, JSON.stringify(again));
  assert.ok(again[0].what.startsWith("a message from alice"), again[0].what);
});
