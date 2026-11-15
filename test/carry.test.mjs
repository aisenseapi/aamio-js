/**
 * aamio-carry-v1, the carrier envelope of contract 3, against its vectors.
 *
 * test/carry_v1_vectors.json is a copy of docs/aamio-carry-v1-vektorer-2026-11-15.json
 * in the service repository, made there by tools/carry-v1-vectors.py from the
 * specification. Every envelope built from its inputs, every refusal read to its
 * code, the frames, the limits and what a writer refuses; then every scenario
 * with a CarryState kept in a real file, a restart being a new CarryState on it.
 * tweetnacl makes none of the strict checks on a signature itself, so the
 * vectors with keys of small order are the ones that matter most here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import nacl from "tweetnacl";
import { Keys, sha256 } from "../src/aamio.js";
import * as carry from "../src/carry.js";
import { CarryState, profile, limits, mark, SAFE, SPENT_KEPT_PER_PARTNER } from "../src/node-carry-state.js";

const vectors = JSON.parse(readFileSync(new URL("./carry_v1_vectors.json", import.meta.url), "utf8"));
const parties = vectors.parties;
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const unhex = (text) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const keys = (name) => Keys.fromSeedHex(parties[name].seed);
const pk = (name) => unhex(parties[name].pk);
const MODES = { readable: carry.READABLE, sealed: carry.SEALED };
const pattern = (length) => Uint8Array.from({ length }, (_, index) => index % 256);
const code = (attempt) => {
  try {
    attempt();
  } catch (error) {
    if (error instanceof carry.CarryRefused) return error.code;
    throw error;
  }
  return null;
};

test("the constants are the ones the vectors were made with", () => {
  const constants = vectors.constants;
  assert.equal(hex(carry.DOMAIN), constants.domain);
  assert.equal(hex(carry.NONCE_LABEL), constants.nonce_label);
  assert.equal(hex(carry.ESK_LABEL), constants.esk_label);
  assert.equal(hex(carry.CHALLENGE_LABEL), constants.challenge_label);
  assert.equal(hex(carry.MAGIC), constants.magic);
  assert.equal(hex(carry.FRAME_MAGIC), constants.frame_magic);
  assert.equal(carry.MAX_CONTENT, constants.max_content);
  assert.equal(carry.CANDIDATES, constants.candidates);
});

test("every party is its seed: key, X25519 key and hint", () => {
  for (const [name, party] of Object.entries(parties)) {
    if (!party.seed) continue;
    const own = keys(name);
    assert.equal(hex(own.publicRaw), party.pk, name);
    assert.equal(own.public, party.pk_b64url, name);
    assert.equal(hex(nacl.scalarMult.base(own.curveSecret)), party.xpk, name);
    assert.equal(hex(carry.hint(own.publicRaw)), party.hint, name);
  }
});

test("every envelope is built to the byte and read back", () => {
  for (const row of vectors.envelopes) {
    const binding = row.binding ? unhex(row.binding) : null;
    const envelope = carry.write(keys(row.sender), pk(row.recipient), MODES[row.mode], row.kind, row.flags, unhex(row.session), row.counter, row.deadline,
      unhex(row.content), { binding, rnd: row.rnd ? unhex(row.rnd) : null });
    assert.equal(hex(envelope), row.envelope, row.name);
    assert.equal(hex(sha256(envelope)), row.sha256, row.name);
    const got = carry.read(envelope, keys(row.recipient), [pk(row.sender), pk("C")], () => binding);
    assert.ok(carry.equal(got.sender, pk(row.sender)) && hex(got.content) === row.content, row.name);
    for (const [limit, frames] of Object.entries(row.frames)) {
      assert.deepEqual(carry.split(envelope, Number(limit)).map(hex), frames, row.name);
      assert.equal(hex(carry.reassemble([...frames].reverse().map(unhex).concat([unhex(frames[0])]))), row.envelope, row.name);
    }
  }
});

test("keys that share a hint are tried in the address book's order", () => {
  for (const row of vectors.readings) {
    const got = carry.read(unhex(row.envelope), keys(row.receiver), row.known.map(pk));
    assert.ok(carry.equal(got.sender, pk(row.sender)), row.name);
  }
});

test("every refusal gives the code of the first check that fails", () => {
  for (const row of vectors.refusals) {
    const table = new Map((row.bindings ?? []).map((entry) => [hex(pk(entry.sender)) + entry.session, unhex(entry.nonce)]));
    const got = code(() => carry.read(unhex(row.envelope), keys(row.receiver), row.known.map(pk), (key, session) => table.get(hex(key) + hex(session)) ?? null));
    assert.equal(got, row.code, row.name);
  }
});

test("the largest content, one byte more, what a writer refuses, and the frame refusals", () => {
  for (const row of vectors.boundaries) {
    const content = pattern(row.content_length);
    const sender = keys(row.sender);
    const recipient = keys(row.recipient);
    const binding = row.binding ? unhex(row.binding) : null;
    if (row.code) {
      const head = carry.concat(carry.MAGIC, Uint8Array.of(carry.READABLE, row.kind, row.flags), carry.hint(recipient.publicRaw), carry.hint(sender.publicRaw),
        unhex(row.session), Uint8Array.of(row.counter >>> 24, (row.counter >>> 16) & 255, (row.counter >>> 8) & 255, row.counter & 255),
        Uint8Array.of(row.deadline >>> 24, (row.deadline >>> 16) & 255, (row.deadline >>> 8) & 255, row.deadline & 255),
        Uint8Array.of((content.length >>> 8) & 255, content.length & 255), content);
      const envelope = carry.concat(head, nacl.sign.detached(carry.concat(carry.DOMAIN, sender.publicRaw, recipient.publicRaw, carry.bind(null), head), sender.signSecret));
      assert.equal(envelope.length, row.length, row.name);
      assert.equal(hex(sha256(envelope)), row.sha256, row.name);
      assert.equal(code(() => carry.read(envelope, recipient, [sender.publicRaw])), row.code, row.name);
      continue;
    }
    const envelope = carry.write(sender, recipient.publicRaw, MODES[row.mode], row.kind, row.flags, unhex(row.session), row.counter, row.deadline, content,
      { binding, rnd: row.rnd ? unhex(row.rnd) : null });
    assert.equal(envelope.length, row.length, row.name);
    assert.equal(hex(sha256(envelope)), row.sha256, row.name);
    const frames = carry.split(envelope, 512);
    assert.equal(frames.length, row.frames_512.count, row.name);
    assert.equal(hex(sha256(carry.concat(...frames))), row.frames_512.sha256_of_all, row.name);
  }
  for (const row of vectors.writer_refusals) {
    const got = row.frame_limit
      ? code(() => carry.split(new Uint8Array(row.envelope_length), row.frame_limit))
      : code(() => carry.write(keys("A"), pk("B"), MODES[row.mode], carry.MESSAGE, 0, new Uint8Array(8), 1, 1794700300, pattern(row.content_length)));
    assert.equal(got, row.code, row.name);
  }
  for (const row of vectors.frame_refusals) assert.equal(code(() => carry.reassemble(row.frames.map(unhex))), row.code, row.name);
});

test("every scenario, step by step, with the state kept in a real file", () => {
  const root = mkdtempSync(join(tmpdir(), "aamio-carry-"));
  try {
    vectors.scenarios.forEach((scenario, number) => {
      const state = {};
      for (const row of scenario.parties) {
        const p = row.profile;
        state[row.name] = {
          state: new CarryState(keys(row.name), join(root, String(number), row.name, "carry.json")),
          known: row.known.map(pk),
          profile: profile({ mode: p.mode, challenge: p.challenge, acceptUnchallenged: p.accept_unchallenged, lifetime: p.lifetime,
            challengeWindow: p.challenge_window, clockTrusted: p.clock_trusted }),
        };
      }
      scenario.steps.forEach((step, index) => {
        const party = state[step.party];
        const where = `${scenario.name}, step ${index}`;
        const sealRnd = step.seal_rnd ? unhex(step.seal_rnd) : null;
        if (step.op === "restart") party.state = new CarryState(party.state.keys, party.state.path);
        else if (step.op === "prune") party.state.prune(step.now);
        else if (step.op === "ask") {
          const [, envelope] = party.state.ask(pk(step.to), party.profile, step.mono, { session: unhex(step.session), rnd: sealRnd });
          assert.equal(hex(envelope), step.envelope, where);
        } else if (step.op === "send") {
          const envelope = party.state.send(pk(step.to), unhex(step.session), unhex(step.content), party.profile, { deadline: step.deadline, rnd: sealRnd });
          assert.equal(hex(envelope), step.envelope, where);
        } else if (step.op === "sent") party.state.rememberSent(pk(step.to), unhex(step.session), step.counter, unhex(step.envelope));
        else {
          let result, reply, refused = null;
          try {
            [result, reply] = party.state.deliver(unhex(step.envelope), party.known, party.profile, step.mono, step.now, { rnd: step.rnd ? unhex(step.rnd) : null, sealRnd });
          } catch (error) {
            if (!(error instanceof carry.CarryRefused)) throw error;
            refused = error.code;
          }
          if (refused !== null) assert.deepEqual(["refused", refused], [step.result, step.code], where);
          else {
            assert.equal(result, step.result, where);
            assert.equal(reply ? hex(reply) : undefined, step.reply, where);
          }
        }
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a kept state of another shape is refused whole rather than read in part, and the maps go out as objects", () => {
  // Another runtime may have written it. A map read as an array here would take entries in memory and write them away as [].
  const root = mkdtempSync(join(tmpdir(), "aamio-carry-shape-"));
  try {
    const file = join(root, "carry.json");
    const empty = { version: 1, floor: null, challenges: 0, incoming: {}, used: [], stored: {}, outgoing: {}, outbox: {} };
    writeFileSync(file, JSON.stringify(empty));
    new CarryState(keys("B"), file).prune(1794700000);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...empty, floor: 1794700000 });
    const without = (name) => Object.fromEntries(Object.entries(empty).filter(([key]) => key !== name));
    const shapes = {
      "an empty map written as a list": { ...empty, incoming: [] },
      "a list where a map goes": { ...empty, outgoing: ["a"] },
      "a record that is not one": { ...empty, incoming: { "a:b": "x" } },
      "a hash that is a number": { ...empty, stored: { "a:b:1": 5 } },
      "used as a map": { ...empty, used: {} },
      "used with a number": { ...empty, used: [1] },
      "a floor as text": { ...empty, floor: "1794700000" },
      "a floor below zero": { ...empty, floor: -1 },
      "a count that is true": { ...empty, challenges: true },
      "no outbox": without("outbox"),
      "no floor": without("floor"),
    };
    for (const [name, shape] of Object.entries(shapes)) {
      writeFileSync(file, JSON.stringify(shape));
      assert.equal(code(() => new CarryState(keys("B"), file)), "carry_state_unreadable", name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a state that cannot be read, a write that fails, and a state that is full", () => {
  const root = mkdtempSync(join(tmpdir(), "aamio-carry-keep-"));
  try {
    const broken = join(root, "broken", "carry.json");
    mkdirSync(join(root, "broken"));
    writeFileSync(broken, "{not json");
    assert.equal(code(() => new CarryState(keys("B"), broken)), "carry_state_unreadable");
    writeFileSync(join(root, "file-in-the-way"), "not a folder");
    const receiver = new CarryState(keys("B"), join(root, "file-in-the-way", "carry.json"));
    const oneWay = profile({ mode: "readable", challenge: false, acceptUnchallenged: true });
    const envelope = carry.write(keys("A"), pk("B"), carry.READABLE, carry.MESSAGE, 0, new Uint8Array(8), 1, 1794700300, Uint8Array.from([104, 101, 105]));
    assert.equal(code(() => receiver.deliver(envelope, [pk("A")], oneWay, 0, 1794700000)), "carry_storage_failed");
    const saved = limits.records;
    limits.records = 3;
    try {
      const full = new CarryState(keys("B"), join(root, "full", "carry.json"));
      assert.equal(full.deliver(envelope, [pk("A")], oneWay, 0, 1794700000)[0], "accepted");
      const second = carry.write(keys("A"), pk("B"), carry.READABLE, carry.MESSAGE, 0, new Uint8Array(8).fill(1), 1, 1794700300, Uint8Array.from([116, 111]));
      assert.equal(code(() => full.deliver(second, [pk("A")], oneWay, 1, 1794700001)), "carry_storage_full");
      assert.equal(full.deliver(envelope, [pk("A")], oneWay, 2, 1794700002)[0], "duplicate");
    } finally {
      limits.records = saved;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the review of 2026-11-15, findings 1 to 13

const T = 1794700000;
const A = keys("A");
const B = keys("B");
const oneWay = profile({ mode: "readable", challenge: false, acceptUnchallenged: true });
const challenged = profile({ mode: "readable" });
const text = (value) => new TextEncoder().encode(value);
const opened = (atA, atB, p = challenged, mono = 0) => {
  const [session, ask] = atA.ask(B.publicRaw, p, mono);
  const [, challenge] = atB.deliver(ask, [A.publicRaw], p, mono, T);
  const [, opening] = atA.deliver(challenge, [B.publicRaw], p, mono, T);
  assert.equal(atB.deliver(opening, [A.publicRaw], p, mono, T)[0], "accepted");
  return session;
};
const inRoot = (name, run) => {
  const root = mkdtempSync(join(tmpdir(), `aamio-carry-${name}-`));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("finding 1: a message is kept with its content until the program says it has it", () => inRoot("kept", (root) => {
  const file = join(root, "b.json");
  const sender = new CarryState(A);
  const session = sender.oneWay(B.publicRaw, T + 300);
  const envelope = sender.send(B.publicRaw, session, text("hei"), oneWay);
  assert.equal(new CarryState(B, file).deliver(envelope, [A.publicRaw], oneWay, 0, T)[0], "accepted");
  const key = mark(A.publicRaw, session, 1);
  const again = new CarryState(B, file);
  assert.deepEqual(again.pending(), [[key, A.publicRaw, session, 1, text("hei")]]);
  assert.deepEqual(again.pending(), [[key, A.publicRaw, session, 1, text("hei")]], "reading is not taking");
  again.handedOver(key);
  const after = new CarryState(B, file);
  const [result, receipt] = after.deliver(envelope, [A.publicRaw], oneWay, 0, T);
  assert.deepEqual([after.pending(), result, receipt !== null], [[], "duplicate", true]);
}));

test("finding 1, the sender: the same bytes and the tries left after a restart, and a late receipt still counts", () => inRoot("sent", (root) => {
  const file = join(root, "a.json");
  const atA = new CarryState(A, file);
  const session = atA.oneWay(B.publicRaw, T + 300);
  const envelope = atA.send(B.publicRaw, session, text("hei"), oneWay, { most: 3 });
  const key = mark(B.publicRaw, session, 1);
  const again = new CarryState(A, file);
  assert.deepEqual([again.outcome(key), again.unconfirmed()], ["waiting", [[key, B.publicRaw, session, 1, envelope]]]);
  assert.ok(again.tried(key) && again.tried(key));
  assert.equal(new CarryState(A, file).durable.outbox[key].tries, 3, "a restart gives back no tries");
  assert.equal(again.tried(key), false);
  assert.deepEqual([again.outcome(key), again.unconfirmed(), again.durable.outbox[key].envelope], ["unknown", [], null]);
  const [, receipt] = new CarryState(B).deliver(envelope, [A.publicRaw], oneWay, 0, T);
  assert.equal(again.deliver(receipt, [B.publicRaw], oneWay, 0, T)[0], "accepted");
  assert.equal(new CarryState(A, file).outcome(key), "confirmed");
}));

test("finding 2: after a write fails nothing is answered until the state is read again", () => inRoot("broken", (root) => {
  const receiver = new CarryState(B, join(root, "in-the-way", "carry.json"));
  writeFileSync(join(root, "in-the-way"), "not a folder");
  const envelope = carry.write(A, B.publicRaw, carry.READABLE, carry.MESSAGE, 0, new Uint8Array(8), 1, T + 300, text("hei"));
  for (let i = 0; i < 2; i++) assert.equal(code(() => receiver.deliver(envelope, [A.publicRaw], oneWay, 0, T)), "carry_storage_failed");
  assert.equal(code(() => receiver.prune(T)), "carry_storage_failed");
}));

test("finding 3: the time floor is kept also when what came is refused", () => inRoot("floor", (root) => {
  const file = join(root, "b.json");
  new CarryState(B, file).prune(T);
  const sender = new CarryState(A);
  const session = sender.oneWay(B.publicRaw, T + 300);
  const envelope = sender.send(B.publicRaw, session, text("sent"), oneWay);
  assert.equal(code(() => new CarryState(B, file).deliver(envelope, [A.publicRaw], oneWay, 0, T + 421)), "carry_deadline_passed");
  const again = new CarryState(B, file);
  assert.equal(again.durable.floor, T + 421);
  assert.equal(code(() => again.deliver(envelope, [A.publicRaw], oneWay, 0, T)), "carry_deadline_passed");
  const noEnvelope = new Uint8Array(204);
  noEnvelope.set(text("XXXX"));
  assert.equal(code(() => again.deliver(noEnvelope, [A.publicRaw], oneWay, 0, T + 900)), "carry_bad_magic");
  assert.equal(new CarryState(B, file).durable.floor, T + 900);
}));

test("finding 7: sixty messages a minute from one partner, copies too, 256 KiB, and ten asks", () => {
  let atB = new CarryState(B);
  const sender = new CarryState(A);
  let session = sender.oneWay(B.publicRaw, T + 3000);
  const first = sender.send(B.publicRaw, session, text("0"), oneWay);
  assert.equal(atB.deliver(first, [A.publicRaw], oneWay, 0, T)[0], "accepted");
  for (let i = 0; i < 59; i++) assert.equal(atB.deliver(first, [A.publicRaw], oneWay, 0.5, T)[0], "duplicate");
  assert.equal(code(() => atB.deliver(first, [A.publicRaw], oneWay, 0.5, T)), "carry_rate_limited");
  const second = sender.send(B.publicRaw, session, text("1"), oneWay);
  assert.equal(code(() => atB.deliver(second, [A.publicRaw], oneWay, 59.9, T)), "carry_rate_limited");
  assert.equal(atB.deliver(second, [A.publicRaw], oneWay, 60, T)[0], "accepted", "the first went out of the minute");
  atB = new CarryState(B);
  session = sender.oneWay(B.publicRaw, T + 3000);
  const big = Array.from({ length: 5 }, (_, n) => sender.send(B.publicRaw, session, new Uint8Array(60000).fill(n), oneWay));
  for (const envelope of big.slice(0, 4)) assert.equal(atB.deliver(envelope, [A.publicRaw], oneWay, 1, T)[0], "accepted");
  assert.equal(code(() => atB.deliver(big[4], [A.publicRaw], oneWay, 2, T)), "carry_rate_limited");
  const atA = new CarryState(A);
  atB = new CarryState(B);
  for (let n = 0; n < 10; n++) opened(atA, atB, challenged, n);
  let [, ask] = atA.ask(B.publicRaw, challenged, 10);
  assert.equal(code(() => atB.deliver(ask, [A.publicRaw], challenged, 10, T)), "carry_rate_limited");
  [, ask] = atA.ask(B.publicRaw, challenged, 61);
  assert.equal(atB.deliver(ask, [A.publicRaw], challenged, 61, T)[0], "accepted");
});

test("finding 8: only challenges that wait inside their window count, and a spent one keeps its code while remembered", () => {
  let atA = new CarryState(A);
  let atB = new CarryState(B);
  for (let n = 0; n < 9; n++) {
    const [, ask] = atA.ask(B.publicRaw, challenged, 100 * n);
    assert.equal(atB.deliver(ask, [A.publicRaw], challenged, 100 * n, T)[0], "accepted");
  }
  for (let n = 0; n < 8; n++) {
    const [, ask] = atA.ask(B.publicRaw, challenged, 1000);
    atB.deliver(ask, [A.publicRaw], challenged, 1000, T);
  }
  let [, ask] = atA.ask(B.publicRaw, challenged, 1000);
  assert.equal(code(() => atB.deliver(ask, [A.publicRaw], challenged, 1000, T)), "carry_rate_limited");
  atA = new CarryState(A);
  atB = new CarryState(B);
  [, ask] = atA.ask(B.publicRaw, challenged, 0);
  const [, challenge] = atB.deliver(ask, [A.publicRaw], challenged, 0, T);
  const [, opening] = atA.deliver(challenge, [B.publicRaw], challenged, 0, T);
  assert.equal(code(() => atB.deliver(opening, [A.publicRaw], challenged, 61, T)), "carry_nonce_expired");
  for (let n = 1; n <= SPENT_KEPT_PER_PARTNER; n++) {
    [, ask] = atA.ask(B.publicRaw, challenged, 61 * n);
    atB.deliver(ask, [A.publicRaw], challenged, 61 * n, T);
  }
  assert.equal(code(() => atB.deliver(opening, [A.publicRaw], challenged, 61 * 65, T)), "carry_nonce_expired");
  [, ask] = atA.ask(B.publicRaw, challenged, 61 * 66);
  atB.deliver(ask, [A.publicRaw], challenged, 61 * 66, T);
  assert.equal(code(() => atB.deliver(opening, [A.publicRaw], challenged, 61 * 66, T)), "carry_nonce_unknown");
});

test("finding 10: the count of challenges stops at 2^53 - 1, never rounded or wrapped", () => inRoot("count", (root) => {
  const file = join(root, "b.json");
  const empty = { version: 1, floor: null, challenges: SAFE - 1, incoming: {}, used: [], stored: {}, outgoing: {}, outbox: {} };
  writeFileSync(file, JSON.stringify(empty));
  const atA = new CarryState(A);
  const atB = new CarryState(B, file);
  let [, ask] = atA.ask(B.publicRaw, challenged, 0);
  assert.equal(atB.deliver(ask, [A.publicRaw], challenged, 0, T)[0], "accepted");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).challenges, SAFE);
  [, ask] = atA.ask(B.publicRaw, challenged, 1);
  assert.equal(code(() => atB.deliver(ask, [A.publicRaw], challenged, 1, T)), "carry_storage_full");
  assert.equal(new CarryState(B, file).durable.challenges, SAFE);
  writeFileSync(file, JSON.stringify(empty).replace(`"challenges":${SAFE - 1}`, '"challenges":9007199254740993'));
  assert.equal(code(() => new CarryState(B, file)), "carry_state_unreadable", "past 2^53 - 1 JSON reads it rounded, so it is refused");
}));

test("finding 11: numbers outside their four bytes are refused, not cut down, and change nothing in the state", () => {
  for (const [counter, deadline] of [[2 ** 32 + 1, 0], [-1, 0], [1, 2 ** 32], [NaN, 0], [Infinity, 0], [1.9, 0], [1, 1.5]]) {
    assert.throws(() => carry.write(A, B.publicRaw, carry.READABLE, carry.MESSAGE, 0, new Uint8Array(8), counter, deadline, text("x")), RangeError, `${counter} ${deadline}`);
  }
  const atA = new CarryState(A);
  const session = opened(atA, new CarryState(B));
  assert.throws(() => atA.send(B.publicRaw, session, text("x"), challenged, { deadline: 2 ** 32 }), RangeError);
  assert.deepEqual([atA.counterOf(B.publicRaw, session), atA.durable.outbox], [0, {}]);
});

test("finding 12: the first message without a challenge needs room for its three records", () => {
  const sender = new CarryState(A);
  const session = sender.oneWay(B.publicRaw, T + 300);
  const envelope = sender.send(B.publicRaw, session, text("hei"), oneWay);
  const saved = limits.records;
  try {
    limits.records = 2;
    const atB = new CarryState(B);
    assert.equal(code(() => atB.deliver(envelope, [A.publicRaw], oneWay, 0, T)), "carry_storage_full");
    assert.deepEqual([atB.durable.incoming, atB.used.size], [{}, 0]);
    limits.records = 3;
    assert.equal(atB.deliver(envelope, [A.publicRaw], oneWay, 0, T)[0], "accepted");
  } finally {
    limits.records = saved;
  }
});

test("finding 13: a session keeps the lifetime it was opened with, a profile can shorten it, never lengthen it", () => {
  const short = profile({ mode: "readable", lifetime: 600 });
  const long = profile({ mode: "readable", lifetime: 86400 });
  const atA = new CarryState(A);
  const atB = new CarryState(B);
  let session = opened(atA, atB, short, 0);
  let envelope = atA.send(B.publicRaw, session, text("x"), short);
  assert.equal(code(() => atB.deliver(envelope, [A.publicRaw], long, 601, T)), "carry_session_expired");
  session = opened(atA, atB, long, 1000);
  envelope = atA.send(B.publicRaw, session, text("y"), long);
  assert.equal(code(() => atB.deliver(envelope, [A.publicRaw], short, 1601, T)), "carry_session_expired");
  assert.equal(atB.deliver(envelope, [A.publicRaw], long, 1601, T)[0], "accepted");
});

test("finding 9: a session with only some of its fields, or one more, is refused whole", () => inRoot("fields", (root) => {
  const file = join(root, "carry.json");
  const pair = "aa".repeat(32) + ":" + "bb".repeat(8);
  const session = { challenged: false, nonce: null, highest: 1, closed: false, deadline: 1794700300, opened: null, closed_at: null, lifetime: null };
  const empty = { version: 1, floor: null, challenges: 0, incoming: {}, used: [], stored: {}, outgoing: {}, outbox: {} };
  writeFileSync(file, JSON.stringify({ ...empty, used: [pair], incoming: { [pair]: session } }));
  assert.ok(new CarryState(B, file));
  const shapes = {
    "only closed": { ...empty, used: [pair], incoming: { [pair]: { closed: false } } },
    "a field more": { ...empty, used: [pair], incoming: { [pair]: { ...session, extra: 1 } } },
    "not among the used": { ...empty, incoming: { [pair]: session } },
    "a mark of no session kept": { ...empty, stored: { [pair + ":1"]: { sha256: "cc".repeat(32), content: null } } },
    "a receipt with its bytes still kept": { ...empty, outbox: { [pair + ":1"]: { sha256: "cc".repeat(32), envelope: "00", receipt: true, tries: 1, most: 30 } } },
  };
  for (const [name, shape] of Object.entries(shapes)) {
    writeFileSync(file, JSON.stringify(shape));
    assert.equal(code(() => new CarryState(B, file)), "carry_state_unreadable", name);
  }
}));

test("a sealed receipt for the same message has the same bytes every time, and another message gets another", () => {
  const sealed = profile({ mode: "sealed", challenge: false, acceptUnchallenged: true });
  const sender = new CarryState(A);
  const atB = new CarryState(B);
  const session = sender.oneWay(B.publicRaw, T + 300);
  const first = sender.send(B.publicRaw, session, text("en"), sealed);
  const second = sender.send(B.publicRaw, session, text("to"), sealed);
  const receipts = [atB.deliver(first, [A.publicRaw], sealed, 0, T)[1], atB.deliver(first, [A.publicRaw], sealed, 1, T)[1]];
  assert.ok(carry.equal(receipts[0], receipts[1]));
  assert.ok(!carry.equal(atB.deliver(second, [A.publicRaw], sealed, 2, T)[1], receipts[0]));
});
