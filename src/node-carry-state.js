// Sessions, counters and receipts for aamio-carry-v1 (contract 3, A6 and A7), for Node.
//
// carry.js says whether an envelope is well formed and signed; this says
// whether it is taken. One CarryState belongs to one home and holds every
// session in both directions over every transport, so a copy that arrives over
// another medium is known again.
//
// What hangs on the monotonic clock goes at a restart: challenges that wait,
// the time each session with a challenge was opened at, and the time this party
// asked. Everything else is written to the home before anything is answered,
// and a write that fails is carry_storage_failed with no receipt. Nothing that
// guards against a replay is deleted before A6.9 allows it.

import fs from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import * as carry from "./carry.js";
import { CarryRefused } from "./carry.js";
import { sha256 } from "./aamio.js";

export const WINDOW = 64;
export const SKEW = 120;
export const HORIZON = 604800;
export const LIFETIME_DEFAULT = 600;
export const LIFETIME_MAX = 86400;
export const CHALLENGE_WINDOW_DEFAULT = 60;
export const MAX_WAITING_PER_PARTNER = 8;
export const MAX_WAITING = 64;
export const MAX_OPEN_PER_PARTNER = 16;
export const limits = { records: 100000, recordsPerPartner: 10000 };
const STATE_VERSION = 1;

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (text) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const pairOf = (pk, session) => toHex(pk) + ":" + toHex(session);
const markOf = (pk, session, counter) => `${toHex(pk)}:${toHex(session)}:${counter}`;

/** A security profile (B5), checked: what the user chose and the core holds to. */
export function profile({ mode = "sealed", challenge = true, acceptUnchallenged = false, lifetime = LIFETIME_DEFAULT,
  challengeWindow = CHALLENGE_WINDOW_DEFAULT, clockTrusted = true, maxContent = carry.MAX_CONTENT } = {}) {
  if (!["sealed", "readable"].includes(mode)) throw new TypeError("mode is sealed or readable");
  if (challenge && acceptUnchallenged) throw new TypeError("a profile with challenges takes nothing without one");
  if (challengeWindow < 10 || challengeWindow > 600) throw new TypeError("challenge_window is 10 to 600 seconds");
  if (lifetime <= challengeWindow || lifetime > LIFETIME_MAX) throw new TypeError("lifetime is longer than challenge_window and at most 86400 seconds");
  if (maxContent < 0 || maxContent > carry.MAX_CONTENT) throw new TypeError(`max_content is at most ${carry.MAX_CONTENT}`);
  return { mode, challenge, acceptUnchallenged, lifetime, challengeWindow, clockTrusted, maxContent };
}

const emptyState = () => ({ version: STATE_VERSION, floor: null, challenges: 0, incoming: {}, used: [], stored: {}, outgoing: {}, outbox: {} });

export class CarryState {
  /** filePath is where the state is kept; null keeps it in memory, for a test. */
  constructor(keys, filePath = null, randomBytes = (n) => nacl.randomBytes(n)) {
    this.keys = keys;
    this.path = filePath;
    this.randomBytes = randomBytes;
    this.durable = this.#load();
    this.used = new Set(this.durable.used);
    this.#forgetTheClock();
  }

  // ------------------------------------------------------------ keeping

  #load() {
    if (this.path === null || !fs.existsSync(this.path)) return emptyState();
    let value = null;
    try {
      value = JSON.parse(fs.readFileSync(this.path, "utf8"));
    } catch {
      value = null;
    }
    if (!value || typeof value !== "object" || value.version !== STATE_VERSION) {
      // Starting from nothing would forget which messages were taken, and a copy of one could then be taken again.
      throw new CarryRefused("carry_state_unreadable", `${this.path} could not be read, so nothing is taken until it is repaired or moved away`);
    }
    return value;
  }

  #save() {
    this.durable.used = [...this.used].sort();
    if (this.path === null) return;
    const tmp = this.path + ".tmp";
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(this.durable));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.path);
    } catch (error) {
      if (error instanceof CarryRefused) throw error;
      throw new CarryRefused("carry_storage_failed", `${this.path} could not be written (${error.code ?? error.name})`);
    }
  }

  #forgetTheClock() {
    this.waiting = new Map();   // pair -> { nonce, t0, used }
    this.anchors = new Map();   // pair of a session with a challenge -> t0 on this party's monotonic clock
    this.askedAt = new Map();   // pair of an outgoing session -> when this party asked
  }

  /** What a new process on the same home would have: the kept state, and nothing from the monotonic clock. */
  restart() {
    if (this.path !== null) this.durable = this.#load();
    this.used = new Set(this.durable.used);
    this.#forgetTheClock();
  }

  #tick(now) {
    this.durable.floor = this.durable.floor === null ? now : Math.max(this.durable.floor, now);
    return this.durable.floor;
  }

  #records(pk = null) {
    const prefix = pk === null ? null : toHex(pk) + ":";
    let count = 0;
    for (const group of [Object.keys(this.durable.incoming), Object.keys(this.durable.stored), Object.keys(this.durable.outgoing), Object.keys(this.durable.outbox), [...this.used]]) {
      for (const key of group) if (prefix === null || key.startsWith(prefix)) count++;
    }
    return count;
  }

  #room(pk, more = 1) {
    if (this.#records() + more > limits.records || this.#records(pk) + more > limits.recordsPerPartner) {
      throw new CarryRefused("carry_storage_full", "the carrier state holds as much as it may, and nothing that guards against a replay is deleted to make room");
    }
  }

  // ------------------------------------------------------------ sending

  /** 8 random bytes in use in neither direction with this partner (A6.2, step 1). */
  newSession(partnerPk) {
    for (;;) {
      const session = this.randomBytes(8);
      const pair = pairOf(partnerPk, session);
      if (!this.used.has(pair) && !(pair in this.durable.outgoing)) return session;
    }
  }

  ask(partnerPk, profileIn, mono, { session = null, rnd = null } = {}) {
    const chosen = session ?? this.newSession(partnerPk);
    const pair = pairOf(partnerPk, chosen);
    this.#room(partnerPk);
    this.durable.outgoing[pair] = { nonce: null, answered: false, counter: 0, closed: false, deadline: null };
    this.#save();
    this.askedAt.set(pair, mono);
    return [chosen, this.#write(partnerPk, profileIn, carry.ASK, 0, chosen, 0, 0, new Uint8Array(0), null, rnd)];
  }

  send(partnerPk, session, content, profileIn, { deadline = 0, rnd = null } = {}) {
    const pair = pairOf(partnerPk, session);
    const out = this.durable.outgoing[pair];
    if (!out || out.closed || !(out.answered || out.deadline)) throw new CarryRefused("carry_session_unknown", "no open session of this party's with that partner");
    if (content.length > profileIn.maxContent) throw new CarryRefused("carry_too_large", `${content.length} bytes, and the profile takes ${profileIn.maxContent}`);
    this.#room(partnerPk);
    out.counter += 1;
    if (out.counter >= 0xffffffff) throw new CarryRefused("carry_session_limit", "the counter is spent; ask for a new session");
    const [flags, binding] = out.answered ? [carry.BOUND, fromHex(out.nonce)] : [0, null];
    const envelope = this.#write(partnerPk, profileIn, carry.MESSAGE, flags, session, out.counter, out.answered ? deadline : out.deadline, content, binding, rnd);
    this.durable.outbox[markOf(partnerPk, session, out.counter)] = toHex(sha256(envelope));
    // The counter and the bytes are kept before they leave, so a crash never sends a counter twice.
    this.#save();
    return envelope;
  }

  counterOf(partnerPk, session) {
    return this.durable.outgoing[pairOf(partnerPk, session)].counter;
  }

  /** A session without a challenge, for a one-way medium: one deadline for all of it (A6.4). */
  oneWay(partnerPk, deadline) {
    const session = this.newSession(partnerPk);
    this.#room(partnerPk);
    this.durable.outgoing[pairOf(partnerPk, session)] = { nonce: null, answered: false, counter: 0, closed: false, deadline };
    this.#save();
    return session;
  }

  rememberSent(partnerPk, session, counter, envelope) {
    this.durable.outbox[markOf(partnerPk, session, counter)] = toHex(sha256(envelope));
    this.#save();
  }

  #write(partnerPk, profileIn, kind, flags, session, counter, deadline, content, binding = null, rnd = null) {
    return carry.write(this.keys, partnerPk, profileIn.mode === "sealed" ? carry.SEALED : carry.READABLE, kind, flags, session, counter, deadline, content, { binding, rnd });
  }

  // ---------------------------------------------------------- receiving

  #bindingFor(pk, session) {
    const record = this.durable.incoming[pairOf(pk, session)];
    return record && record.challenged ? fromHex(record.nonce) : null;
  }

  /** An envelope that came over a transport: [result, what goes back or null, what was read], or CarryRefused. */
  deliver(envelope, known, profileIn, mono, now, { rnd = null, sealRnd = null } = {}) {
    const t = this.#tick(now);
    const got = carry.read(envelope, this.keys, known, (pk, session) => this.#bindingFor(pk, session));
    if (got.mode !== (profileIn.mode === "sealed" ? carry.SEALED : carry.READABLE)) throw new CarryRefused("carry_mode_refused");
    const pk = got.sender;
    const session = got.session;
    const pair = pairOf(pk, session);
    const prefix = toHex(pk) + ":";
    const { incoming, outgoing } = this.durable;

    if (got.kind === carry.ASK) {
      if (this.used.has(pair) || pair in outgoing) throw new CarryRefused("carry_session_in_use");
      const waitingForPartner = [...this.waiting.keys()].filter((key) => key.startsWith(prefix)).length;
      if (waitingForPartner >= MAX_WAITING_PER_PARTNER || this.waiting.size >= MAX_WAITING) throw new CarryRefused("carry_rate_limited", "too many challenges wait");
      const open = Object.entries(incoming).filter(([key, record]) => key.startsWith(prefix) && record.challenged && !record.closed && this.anchors.has(key)).length;
      if (open >= MAX_OPEN_PER_PARTNER) throw new CarryRefused("carry_session_limit");
      this.#room(pk);
      this.durable.challenges += 1;
      const nonce = carry.challengeNonce(this.keys, rnd ?? this.randomBytes(32), pk, session, this.durable.challenges);
      this.used.add(pair);
      this.#save();
      this.waiting.set(pair, { nonce, t0: mono, used: false });
      return ["accepted", this.#write(pk, profileIn, carry.CHALLENGE, 0, session, 0, 0, nonce, null, sealRnd), got];
    }
    if (got.kind === carry.CHALLENGE) {
      const out = outgoing[pair];
      const asked = this.askedAt.get(pair);
      if (!out || out.answered || asked === undefined || mono - asked > profileIn.challengeWindow) throw new CarryRefused("carry_challenge_unexpected");
      out.answered = true;
      out.nonce = toHex(got.content);
      this.#save();
      return ["accepted", this.#write(pk, profileIn, carry.OPEN, 0, session, 0, 0, got.content, null, sealRnd), got];
    }
    if (got.kind === carry.OPEN) {
      const entry = this.waiting.get(pair);
      if (!entry || !carry.equal(entry.nonce, got.content)) throw new CarryRefused("carry_nonce_unknown");
      if (entry.used) throw new CarryRefused("carry_nonce_used");
      if (mono - entry.t0 > profileIn.challengeWindow) throw new CarryRefused("carry_nonce_expired");
      entry.used = true;
      // The lifetime goes with the session, so deleting it later does not depend on a profile that may have changed.
      incoming[pair] = { challenged: true, nonce: toHex(entry.nonce), highest: 0, closed: false, deadline: null, opened: t, closed_at: null, lifetime: profileIn.lifetime };
      this.#save();
      this.anchors.set(pair, entry.t0);
      return ["accepted", null, got];
    }
    if (got.kind === carry.CLOSE) {
      const record = incoming[pair] ?? outgoing[pair];
      if (!record) throw new CarryRefused("carry_session_unknown");
      if (record.closed) throw new CarryRefused("carry_session_closed");
      record.closed = true;
      record.closed_at = t;
      this.#save();
      return ["accepted", null, got];
    }
    if (got.kind === carry.RECEIPT) {
      const body = got.content;
      const counter = ((body[9] << 24) >>> 0) + (body[10] << 16) + (body[11] << 8) + body[12];
      if (this.durable.outbox[markOf(pk, body.slice(1, 9), counter)] !== toHex(body.slice(13, 45))) throw new CarryRefused("carry_receipt_unknown");
      return ["accepted", null, got];
    }
    return this.#message(envelope, got, pair, profileIn, mono, t, sealRnd);
  }

  /** A6.6, step by step. */
  #message(envelope, got, pair, profileIn, mono, t, sealRnd) {
    const { sender: pk, session, counter, deadline } = got;
    const digest = toHex(sha256(envelope));
    const trusted = profileIn.clockTrusted;
    const receipt = () => this.#write(pk, profileIn, carry.RECEIPT, 0, session, 0, 0, carry.receiptBody(carry.STORED, session, counter, envelope), null, sealRnd);

    const mark = markOf(pk, session, counter);
    const stored = this.durable.stored[mark];
    if (stored !== undefined) {
      if (stored !== digest) throw new CarryRefused("carry_counter_reused");
      return ["duplicate", receipt(), got];
    }
    const { incoming } = this.durable;
    let record = incoming[pair];
    let isNew = false;
    const bound = Boolean(got.flags & carry.BOUND);
    if (!bound && pair in this.durable.outgoing) throw new CarryRefused("carry_wrong_direction");
    if (!bound) {
      if (record && record.challenged) throw new CarryRefused("carry_binding_mismatch");
      if (!record) {
        if (!profileIn.acceptUnchallenged) throw new CarryRefused("carry_session_unknown");
        record = { challenged: false, nonce: null, highest: 0, closed: false, deadline, opened: null, closed_at: null };
        isNew = true;
      }
    }
    if (record.closed) throw new CarryRefused("carry_session_closed");
    if (record.challenged) {
      const t0 = this.anchors.get(pair);
      if (t0 === undefined || mono - t0 > profileIn.lifetime) throw new CarryRefused("carry_session_expired");
    }
    if (counter <= record.highest - WINDOW) throw new CarryRefused("carry_counter_too_old");
    if (deadline !== 0 && trusted) {
      if (t > deadline + SKEW) throw new CarryRefused("carry_deadline_passed");
      if (deadline > t + HORIZON) throw new CarryRefused("carry_deadline_too_far");
    }
    if (!record.challenged) {
      if (deadline === 0 || !trusted) throw new CarryRefused("carry_freshness_unknown");
      if (deadline !== record.deadline) throw new CarryRefused("carry_deadline_mismatch");
    }
    if (got.content.length > profileIn.maxContent) throw new CarryRefused("carry_too_large", `${got.content.length} bytes, and the profile takes ${profileIn.maxContent}`);
    this.#room(pk, isNew ? 2 : 1);
    record.highest = Math.max(record.highest, counter);
    incoming[pair] = record;
    if (isNew) this.used.add(pair);
    this.durable.stored[mark] = digest;
    this.#save();
    return ["accepted", receipt(), got];
  }

  // ----------------------------------------------------------- deleting

  /** Delete what A6.9 allows at this time, by the time floor, and nothing more. */
  prune(now) {
    const floor = this.#tick(now);
    for (const [pair, record] of Object.entries(this.durable.incoming)) {
      const gone = record.challenged
        ? floor > Math.max(record.opened + record.lifetime, record.closed_at ?? 0) + HORIZON
        : floor > record.deadline + SKEW;
      if (gone) {
        delete this.durable.incoming[pair];
        this.used.delete(pair);
        this.anchors.delete(pair);
        for (const mark of Object.keys(this.durable.stored)) if (mark.startsWith(pair + ":")) delete this.durable.stored[mark];
      }
    }
    this.#save();
  }
}
