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
import { CarryState, profile, limits } from "../src/node-carry-state.js";

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
