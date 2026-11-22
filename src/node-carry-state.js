// Sessions, counters and receipts for aamio-carry-v1 (contract 3, A6 and A7), for Node.
//
// carry.js says whether an envelope is well formed and signed; this says
// whether it is taken. One CarryState belongs to one home and holds every
// session in both directions over every transport, so a copy that arrives over
// another medium is known again.
//
// What hangs on the monotonic clock goes at a restart: challenges that wait,
// the time each session with a challenge was opened at, the time this party
// asked, and the counts behind the limits per minute. Everything else is
// written to the home before anything is answered: the sessions, the session
// ids that were used, each message taken with its mark and its content until
// the program says it has it, each message sent with its bytes and its tries
// until its receipt comes, the time floor and the count of challenges given.
// A write that fails is carry_storage_failed with no receipt, and the state
// then refuses everything until restart has read the file again. Nothing that
// guards against a replay is deleted before A6.9 allows it.
//
// The kept state has one shape in every runtime, since another runtime may
// take the home over: docs/aamio-carry-v1-tilstand-2026-11-15.md in the
// service says it field by field. A file of any other shape is refused whole
// as carry_state_unreadable: a map read as an array here would take new
// entries in memory and write them away as [].

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
export const CHALLENGE_WINDOW_MIN = 10;
export const MAX_WAITING_PER_PARTNER = 8;
export const MAX_WAITING = 64;
export const MAX_OPEN_PER_PARTNER = 16;
export const MESSAGES_PER_MINUTE = 60;
export const BYTES_PER_MINUTE = 262144;
export const ASKS_PER_MINUTE = 10;
export const SPENT_KEPT_PER_PARTNER = 64;
export const TRIES_DEFAULT = 30;
export const U32 = 0xffffffff;
/** The largest whole number JSON keeps exact in every runtime. */
export const SAFE = Number.MAX_SAFE_INTEGER;
export const limits = { records: 100000, recordsPerPartner: 10000 };
const STATE_VERSION = 1;
const ENVELOPE_MOST = 43 + 24 + carry.MAX_CONTENT + 64 + 16;
const NONCE_BYTES = 16;
const RECEIPT_RND = new TextEncoder().encode("aamio-carry-v1 receipt\n");

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (text) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const pairOf = (pk, session) => toHex(pk) + ":" + toHex(session);

/** The id a message is known by in both homes and after a restart: partner, session and counter. */
export const mark = (pk, session, counter) => `${toHex(pk)}:${toHex(session)}:${counter}`;

const parts = (key) => {
  const [pk, session, counter] = key.split(":");
  return [fromHex(pk), fromHex(session), Number(counter)];
};

// ------------------------------------------------------------------ the shape

const PAIR = /^[0-9a-f]{64}:[0-9a-f]{16}$/;
const MARK = /^([0-9a-f]{64}:[0-9a-f]{16}):(0|[1-9][0-9]{0,9})$/;
const HEX = /^(?:[0-9a-f]{2})*$/;
const TOP = ["challenges", "floor", "incoming", "outbox", "outgoing", "stored", "used", "version"];
const INCOMING = ["challenged", "closed", "closed_at", "deadline", "highest", "lifetime", "nonce", "opened"];
const OUTGOING = ["answered", "closed", "closed_at", "counter", "deadline", "nonce"];
const STORED = ["at", "content", "sealed", "sha256"];
const OUTBOX = ["envelope", "most", "receipt", "sha256", "tries"];

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const int = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const time = (value) => value === null || int(value, 0, SAFE);
const hex = (value, size = null, most = null) => typeof value === "string" && HEX.test(value)
  && (size === null || value.length === 2 * size) && (most === null || value.length <= 2 * most);
const fields = (record, sorted) => isMap(record) && Object.keys(record).sort().join(",") === sorted.join(",");
const markOk = (key) => {
  const found = MARK.exec(key);
  return found !== null && Number(found[2]) <= U32;
};

function incomingOk(record) {
  if (!fields(record, INCOMING) || typeof record.challenged !== "boolean" || typeof record.closed !== "boolean" || !int(record.highest, 0, U32)) return false;
  if (record.closed !== (record.closed_at !== null) || !time(record.closed_at)) return false;
  if (record.challenged) {
    return hex(record.nonce, NONCE_BYTES) && record.deadline === null && int(record.opened, 0, SAFE) && int(record.lifetime, CHALLENGE_WINDOW_MIN + 1, LIFETIME_MAX);
  }
  return record.nonce === null && int(record.deadline, 1, U32) && record.opened === null && record.lifetime === null;
}

function outgoingOk(record) {
  if (!fields(record, OUTGOING) || typeof record.answered !== "boolean" || typeof record.closed !== "boolean" || !int(record.counter, 0, U32)) return false;
  if (record.closed !== (record.closed_at !== null) || !time(record.closed_at)) return false;
  if (record.answered) return hex(record.nonce, NONCE_BYTES) && record.deadline === null;
  return record.nonce === null && (record.deadline === null || int(record.deadline, 1, U32));
}

const storedOk = (entry) => fields(entry, STORED) && hex(entry.sha256, 32) && (entry.content === null || hex(entry.content, null, carry.MAX_CONTENT))
  && typeof entry.sealed === "boolean" && int(entry.at, 0, SAFE);

function outboxOk(entry) {
  if (!fields(entry, OUTBOX) || !hex(entry.sha256, 32) || typeof entry.receipt !== "boolean") return false;
  if (!int(entry.most, 1, U32) || !int(entry.tries, 0, entry.most)) return false;
  return entry.envelope === null || (hex(entry.envelope, null, ENVELOPE_MOST) && !entry.receipt);
}

/** The shape every runtime writes (the tilstand document): anything else is not read at all. */
export function readable(value) {
  if (!fields(value, TOP) || value.version !== STATE_VERSION || !time(value.floor) || !int(value.challenges, 0, SAFE)) return false;
  const { used, incoming, stored, outgoing, outbox } = value;
  if (!Array.isArray(used) || !used.every((item) => typeof item === "string" && PAIR.test(item)) || new Set(used).size !== used.length) return false;
  if (![incoming, stored, outgoing, outbox].every(isMap)) return false;
  if (!Object.entries(incoming).every(([key, record]) => PAIR.test(key) && incomingOk(record))) return false;
  if (!Object.entries(outgoing).every(([key, record]) => PAIR.test(key) && outgoingOk(record))) return false;
  if (!Object.entries(stored).every(([key, entry]) => markOk(key) && storedOk(entry))) return false;
  if (!Object.entries(outbox).every(([key, entry]) => markOk(key) && outboxOk(entry))) return false;
  // What belongs together: a session taken in is a session id used, and a message kept belongs to a session kept.
  const usedSet = new Set(used);
  return Object.keys(incoming).every((key) => usedSet.has(key)) && Object.keys(stored).every((key) => Object.hasOwn(incoming, MARK.exec(key)[1]));
}

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

/** What was seen in the last minute on the monotonic clock: [mono, bytes], oldest first. */
const minute = (seen, mono) => {
  while (seen.length && mono - seen[0][0] >= 60) seen.shift();
  return seen;
};

export class CarryState {
  /** filePath is where the state is kept; null keeps it in memory, for a test. */
  constructor(keys, filePath = null, randomBytes = (n) => nacl.randomBytes(n)) {
    this.keys = keys;
    this.path = filePath;
    this.randomBytes = randomBytes;
    this.broken = false;
    this.durable = this.#load();
    this.used = new Set(this.durable.used);
    this.keptFloor = this.durable.floor;
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
    if (!readable(value)) {
      // Starting from nothing would forget which messages were taken, and a copy of one could then be taken again;
      // reading only part of it would write the rest away at the next save.
      throw new CarryRefused("carry_state_unreadable", `${this.path} could not be read, so nothing is taken until it is repaired or moved away`);
    }
    return value;
  }

  #save() {
    this.durable.used = [...this.used].sort();
    if (this.path !== null) {
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
        // What is in memory may now hold what the file does not: nothing more is answered from it.
        this.broken = true;
        throw new CarryRefused("carry_storage_failed", `${this.path} could not be written (${error.code ?? error.name})`);
      }
    }
    this.keptFloor = this.durable.floor;
  }

  #check() {
    if (this.broken) throw new CarryRefused("carry_storage_failed", `a write of ${this.path} failed, so nothing is taken or sent until restart has read it again`);
  }

  #forgetTheClock() {
    this.waiting = new Map();        // pair -> { nonce, t0, used, window }: the window of the profile it was given under
    this.anchors = new Map();        // pair of a session with a challenge -> t0 on this party's monotonic clock
    this.askedAt = new Map();        // pair of an outgoing session -> when this party asked
    this.messagesSeen = new Map();   // pk hex -> [mono, bytes] of messages in the last minute
    this.asksSeen = new Map();       // pk hex -> [mono, 0] of asks answered in the last minute
  }

  /** What a new process on the same home would have: the kept state, and nothing from the monotonic clock. */
  restart() {
    if (this.path !== null) {
      this.durable = this.#load();
      this.broken = false;
    }
    this.used = new Set(this.durable.used);
    this.keptFloor = this.durable.floor;
    this.#forgetTheClock();
  }

  #tick(now) {
    this.durable.floor = this.durable.floor === null ? now : Math.max(this.durable.floor, now);
    return this.durable.floor;
  }

  /** A higher floor is kept before anything is answered, also a refusal (A6.6.6): a passed deadline never comes back. */
  #keepFloor() {
    if (this.durable.floor !== this.keptFloor) this.#save();
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
      if (!this.used.has(pair) && !Object.hasOwn(this.durable.outgoing, pair)) return session;
    }
  }

  ask(partnerPk, profileIn, mono, { session = null, rnd = null } = {}) {
    this.#check();
    const chosen = session ?? this.newSession(partnerPk);
    const pair = pairOf(partnerPk, chosen);
    this.#room(partnerPk);
    this.durable.outgoing[pair] = { nonce: null, answered: false, counter: 0, closed: false, closed_at: null, deadline: null };
    this.#save();
    this.askedAt.set(pair, mono);
    return [chosen, this.#write(partnerPk, profileIn, carry.ASK, 0, chosen, 0, 0, new Uint8Array(0), null, rnd)];
  }

  /**
   * A message in this party's own session: bound where it was opened with a challenge, with one deadline where it was not.
   * The envelope is kept in the outbox with its tries before it leaves, so a crash never sends a counter twice, and a
   * carrier on the same home after a restart sends the same bytes again.
   */
  send(partnerPk, session, content, profileIn, { deadline = 0, rnd = null, most = TRIES_DEFAULT } = {}) {
    this.#check();
    if (!int(deadline, 0, U32)) throw new RangeError("a deadline is a whole number of seconds from 0 to 2^32 - 1");
    if (!int(most, 1, U32)) throw new RangeError("most is the number of tries, at least 1");
    const pair = pairOf(partnerPk, session);
    const out = this.durable.outgoing[pair];
    if (!Object.hasOwn(this.durable.outgoing, pair) || out.closed || !(out.answered || out.deadline)) {
      throw new CarryRefused("carry_session_unknown", "no open session of this party's with that partner");
    }
    if (content.length > profileIn.maxContent) throw new CarryRefused("carry_too_large", `${content.length} bytes, and the profile takes ${profileIn.maxContent}`);
    if (out.counter + 1 >= U32) throw new CarryRefused("carry_session_limit", "the counter is spent; ask for a new session");
    this.#room(partnerPk);
    const counter = out.counter + 1;
    const [flags, binding] = out.answered ? [carry.BOUND, fromHex(out.nonce)] : [0, null];
    const envelope = this.#write(partnerPk, profileIn, carry.MESSAGE, flags, session, counter, out.answered ? deadline : out.deadline, content, binding, rnd);
    out.counter = counter;
    this.durable.outbox[mark(partnerPk, session, counter)] = { sha256: toHex(sha256(envelope)), envelope: toHex(envelope), receipt: false, tries: 1, most };
    this.#save();
    return envelope;
  }

  counterOf(partnerPk, session) {
    return this.durable.outgoing[pairOf(partnerPk, session)].counter;
  }

  /** A session without a challenge, for a one-way medium: one deadline for all of it (A6.4). */
  oneWay(partnerPk, deadline) {
    this.#check();
    if (!int(deadline, 1, U32)) throw new RangeError("a session without a challenge has one deadline, from 1 to 2^32 - 1");
    const session = this.newSession(partnerPk);
    this.#room(partnerPk);
    this.durable.outgoing[pairOf(partnerPk, session)] = { nonce: null, answered: false, counter: 0, closed: false, closed_at: null, deadline };
    this.#save();
    return session;
  }

  /** An envelope sent before, for a receipt to be matched against. */
  rememberSent(partnerPk, session, counter, envelope, most = TRIES_DEFAULT) {
    this.#check();
    this.#room(partnerPk);
    this.durable.outbox[mark(partnerPk, session, counter)] = { sha256: toHex(sha256(envelope)), envelope: toHex(envelope), receipt: false, tries: 1, most };
    this.#save();
  }

  /**
   * waiting while the bytes are kept for another try, confirmed when the receipt came, and unknown otherwise: the tries
   * ran out, so it may or may not have arrived, or nothing is known of it here.
   *
   * After a write failed nothing is answered from memory: what is held there may be what never reached the file, as a
   * receipt taken in whose save failed (the follow-up check of 15 November 2026).
   */
  outcome(key) {
    this.#check();
    if (!Object.hasOwn(this.durable.outbox, key)) return "unknown";
    const entry = this.durable.outbox[key];
    if (entry.receipt) return "confirmed";
    return entry.envelope !== null ? "waiting" : "unknown";
  }

  /**
   * One more try of a message waiting for its receipt, counted before it goes: true while the budget allows it. When the
   * tries are used up the bytes go and the outcome is unknown for good, but the hash stays, so a valid receipt that
   * comes late still confirms it (A7).
   */
  tried(key) {
    this.#check();
    if (!Object.hasOwn(this.durable.outbox, key)) return false;
    const entry = this.durable.outbox[key];
    if (entry.receipt || entry.envelope === null) return false;
    if (entry.tries >= entry.most) {
      entry.envelope = null;
      this.#save();
      return false;
    }
    entry.tries += 1;
    this.#save();
    return true;
  }

  /**
   * How many more tries the budget allows a message that waits for its receipt. Nothing is counted: whoever asks can
   * then wait with the try until it can go.
   */
  triesLeft(key) {
    this.#check();
    if (!Object.hasOwn(this.durable.outbox, key)) return 0;
    const entry = this.durable.outbox[key];
    if (entry.receipt || entry.envelope === null) return 0;
    return Math.max(0, entry.most - entry.tries);
  }

  /**
   * A message that cannot go on as it was written, as one written readable for a partner whose profile is sealed now:
   * its bytes go, as when the tries are used, and its mark and hash stay, so a receipt that comes late still confirms
   * it. It is never sealed again under its mark (B5, A7). True when there was something to give up.
   */
  giveUp(key) {
    this.#check();
    if (!Object.hasOwn(this.durable.outbox, key)) return false;
    const entry = this.durable.outbox[key];
    if (entry.receipt || entry.envelope === null) return false;
    entry.envelope = null;
    this.#save();
    return true;
  }

  /**
   * Whether a message of this party's in its session with the partner went tries tries without a receipt, or ran out of
   * them, while no later message in the session has one: then the partner may no longer have the session, as after a
   * restart, where it is taken as expired (A6.8) and nothing it refuses is answered over the medium (A7).
   */
  unanswered(partnerPk, session, tries) {
    this.#check();
    const prefix = pairOf(partnerPk, session) + ":";
    let confirmed = 0;
    let silent = 0;
    for (const [key, entry] of Object.entries(this.durable.outbox)) {
      if (!key.startsWith(prefix)) continue;
      const counter = Number(key.slice(prefix.length));
      if (entry.receipt) confirmed = Math.max(confirmed, counter);
      else if (entry.envelope === null || entry.tries >= tries) silent = Math.max(silent, counter);
    }
    return silent > confirmed;
  }

  /** What was sent and waits for its receipt, oldest first: [mark, partner pk, session, counter, envelope]. */
  unconfirmed() {
    this.#check();
    return Object.entries(this.durable.outbox).filter(([, entry]) => entry.envelope !== null && !entry.receipt)
      .map(([key, entry]) => [key, ...parts(key), fromHex(entry.envelope)]);
  }

  #write(partnerPk, profileIn, kind, flags, session, counter, deadline, content, binding = null, rnd = null) {
    return carry.write(this.keys, partnerPk, profileIn.mode === "sealed" ? carry.SEALED : carry.READABLE, kind, flags, session, counter, deadline, content, { binding, rnd });
  }

  // ------------------------------------------------- what the program takes

  /**
   * Messages taken and kept that the program has not said it has, in the order they came: [mark, sender pk, session,
   * counter, content]. Reading them takes nothing: a crash before handedOver offers them again, so the program can use the
   * mark to do nothing twice.
   */
  pending() {
    this.#check();
    return Object.entries(this.durable.stored).filter(([, entry]) => entry.content !== null)
      .map(([key, entry]) => [key, ...parts(key), fromHex(entry.content)]);
  }

  /** What is kept of a message taken in: sha256, whether it came sealed, and when (the time floor's clock), or null. */
  kept(key) {
    this.#check();
    if (!Object.hasOwn(this.durable.stored, key)) return null;
    const { sha256, sealed, at } = this.durable.stored[key];
    return { sha256, sealed, at };
  }

  /** The program has kept the message itself or is done with it: the content goes, the mark stays until A6.9. */
  handedOver(key) {
    this.#check();
    if (Object.hasOwn(this.durable.stored, key) && this.durable.stored[key].content !== null) {
      this.durable.stored[key].content = null;
      this.#save();
    }
  }

  // ---------------------------------------------------------- receiving

  /**
   * N for a bound message: its session's, or, where the session is not opened, that of a challenge given for it that waits
   * unused in its window, which the message then opens as an open would (A6.2 point 6).
   */
  #bindingFor(pk, session, mono = null) {
    const pair = pairOf(pk, session);
    if (Object.hasOwn(this.durable.incoming, pair)) {
      const record = this.durable.incoming[pair];
      return record.challenged ? fromHex(record.nonce) : null;
    }
    const entry = this.waiting.get(pair);
    if (entry && mono !== null && !entry.used && mono - entry.t0 <= entry.window) return entry.nonce;
    return null;
  }

  /** The session the challenge entry was given for, opened: by its open, or by a bound message that came first. */
  #opened(pk, pair, entry, profileIn, t) {
    this.#room(pk);
    entry.used = true;
    // The lifetime goes with the session: a profile changed later can shorten it, never lengthen it (A6.6.4).
    const record = { challenged: true, nonce: toHex(entry.nonce), highest: 0, closed: false, deadline: null, opened: t, closed_at: null, lifetime: profileIn.lifetime };
    this.durable.incoming[pair] = record;
    this.#save();
    this.anchors.set(pair, entry.t0);
    return record;
  }

  /**
   * An envelope that came over a transport: [result, what goes back or null, what was read], or CarryRefused. profileIn is
   * a profile, or a function from the sender's key to its profile, asked once the sender is known.
   */
  deliver(envelope, known, profileIn, mono, now, { rnd = null, sealRnd = null } = {}) {
    this.#check();
    let answer;
    try {
      answer = this.#take(envelope, known, profileIn, mono, now, rnd, sealRnd);
    } catch (error) {
      if (error instanceof CarryRefused && error.code !== "carry_storage_failed") this.#keepFloor();
      throw error;
    }
    this.#keepFloor();
    return answer;
  }

  /**
   * Challenges used or past their own window are remembered for their own code, nonce_used or nonce_expired, at most
   * SPENT_KEPT_PER_PARTNER per partner; an open for one forgotten is nonce_unknown. Either way it is refused, and nothing
   * kept against a replay goes with it.
   */
  #forgetSpent(prefix, mono) {
    const spent = [...this.waiting].filter(([key, entry]) => key.startsWith(prefix) && (entry.used || mono - entry.t0 > entry.window))
      .sort((a, b) => a[1].t0 - b[1].t0);
    for (const [key] of spent.slice(0, Math.max(0, spent.length - SPENT_KEPT_PER_PARTNER))) this.waiting.delete(key);
  }

  #take(envelope, known, profileIn, mono, now, rnd, sealRnd) {
    const t = this.#tick(now);
    const got = carry.read(envelope, this.keys, known, (pk, session) => this.#bindingFor(pk, session, mono));
    try {
      return this.#taken(envelope, got, profileIn, mono, t, rnd, sealRnd);
    } catch (error) {
      // Refused after the sender was verified: who and in which session go with it, so the carrier can say it where the
      // user sees it (A7). Until 22 November 2026 a refusal said nothing of whom it came from.
      if (error instanceof CarryRefused) error.reading = got;
      throw error;
    }
  }

  /** What A6 and A7 make of an envelope that was read and its sender verified. */
  #taken(envelope, got, profileIn, mono, t, rnd, sealRnd) {
    if (typeof profileIn === "function") profileIn = profileIn(got.sender);
    if (got.mode !== (profileIn.mode === "sealed" ? carry.SEALED : carry.READABLE)) throw new CarryRefused("carry_mode_refused");
    const pk = got.sender;
    const session = got.session;
    const pair = pairOf(pk, session);
    const prefix = toHex(pk) + ":";
    const { incoming, outgoing } = this.durable;

    if (got.kind === carry.ASK) {
      if (this.used.has(pair) || Object.hasOwn(outgoing, pair)) throw new CarryRefused("carry_session_in_use");
      const window = profileIn.challengeWindow;
      // Each challenge waits in the window of the profile it was given under: counted with this ask's window, one still
      // open in a longer window of another partner's was counted as gone (the follow-up check of 15 November 2026).
      const live = [...this.waiting].filter(([, entry]) => !entry.used && mono - entry.t0 <= entry.window);
      if (live.filter(([key]) => key.startsWith(prefix)).length >= MAX_WAITING_PER_PARTNER || live.length >= MAX_WAITING) {
        throw new CarryRefused("carry_rate_limited", "too many challenges wait");
      }
      const asks = minute(this.asksSeen.get(toHex(pk)) ?? [], mono);
      this.asksSeen.set(toHex(pk), asks);
      if (asks.length >= ASKS_PER_MINUTE) throw new CarryRefused("carry_rate_limited", `${ASKS_PER_MINUTE} asks a minute from one partner`);
      const open = Object.entries(incoming).filter(([key, record]) => key.startsWith(prefix) && record.challenged && !record.closed && this.anchors.has(key)).length;
      if (open >= MAX_OPEN_PER_PARTNER) throw new CarryRefused("carry_session_limit");
      if (this.durable.challenges >= SAFE) throw new CarryRefused("carry_storage_full", "the count of challenges given is spent at 2^53 - 1, so no new one can be given");
      this.#room(pk);
      this.durable.challenges += 1;
      const nonce = carry.challengeNonce(this.keys, rnd ?? this.randomBytes(32), pk, session, this.durable.challenges);
      this.used.add(pair);
      this.#save();
      asks.push([mono, 0]);
      this.waiting.set(pair, { nonce, t0: mono, used: false, window });
      this.#forgetSpent(prefix, mono);
      return ["accepted", this.#write(pk, profileIn, carry.CHALLENGE, 0, session, 0, 0, nonce, null, sealRnd), got];
    }
    if (got.kind === carry.CHALLENGE) {
      const out = outgoing[pair];
      const asked = this.askedAt.get(pair);
      if (!Object.hasOwn(outgoing, pair) || out.answered || asked === undefined || mono - asked > profileIn.challengeWindow) {
        throw new CarryRefused("carry_challenge_unexpected");
      }
      out.answered = true;
      out.nonce = toHex(got.content);
      this.#save();
      return ["accepted", this.#write(pk, profileIn, carry.OPEN, 0, session, 0, 0, got.content, null, sealRnd), got];
    }
    if (got.kind === carry.OPEN) {
      const entry = this.waiting.get(pair);
      if (!entry || !carry.equal(entry.nonce, got.content)) throw new CarryRefused("carry_nonce_unknown");
      if (entry.used) throw new CarryRefused("carry_nonce_used");
      // In the window it was given under, as the quota counts it and as it is forgotten: taken in the window of the
      // profile now, a challenge the quota no longer counted still opened a session when the profile had come to
      // have a longer window (the check of 16 November 2026). A profile changed later neither lengthens nor
      // shortens what was given.
      if (mono - entry.t0 > entry.window) throw new CarryRefused("carry_nonce_expired");
      this.#opened(pk, pair, entry, profileIn, t);
      return ["accepted", null, got];
    }
    if (got.kind === carry.CLOSE) {
      const record = Object.hasOwn(incoming, pair) ? incoming[pair] : Object.hasOwn(outgoing, pair) ? outgoing[pair] : null;
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
      const key = mark(pk, body.slice(1, 9), counter);
      const entry = Object.hasOwn(this.durable.outbox, key) ? this.durable.outbox[key] : null;
      if (entry === null || entry.sha256 !== toHex(body.slice(13, 45))) throw new CarryRefused("carry_receipt_unknown");
      if (!entry.receipt) {
        entry.receipt = true;
        entry.envelope = null;
        this.#save();
      }
      return ["accepted", null, got];
    }
    return this.#message(envelope, got, pair, profileIn, mono, t, sealRnd);
  }

  /** A6.6, step by step, within the limits per minute of A10. */
  #message(envelope, got, pair, profileIn, mono, t, sealRnd) {
    const { sender: pk, session, counter, deadline } = got;
    const digest = toHex(sha256(envelope));
    const trusted = profileIn.clockTrusted;
    // The same message gets the same receipt, byte for byte, so on a medium that loses frames the frames of several
    // copies add up. The ephemeral key still comes from the seed and the receipt's own bytes (A4).
    const receiptRnd = sealRnd ?? sha256(carry.concat(RECEIPT_RND, fromHex(digest)));
    const receipt = () => this.#write(pk, profileIn, carry.RECEIPT, 0, session, 0, 0, carry.receiptBody(carry.STORED, session, counter, envelope), null, receiptRnd);

    // Every message from a known partner counts, a copy too: a copy is answered with a receipt, and A10 has no limit apart
    // from this one on what that costs.
    const seen = minute(this.messagesSeen.get(toHex(pk)) ?? [], mono);
    this.messagesSeen.set(toHex(pk), seen);
    if (seen.length >= MESSAGES_PER_MINUTE || seen.reduce((sum, [, size]) => sum + size, 0) + envelope.length > BYTES_PER_MINUTE) {
      throw new CarryRefused("carry_rate_limited", `${MESSAGES_PER_MINUTE} messages and ${BYTES_PER_MINUTE} bytes a minute from one partner`);
    }
    seen.push([mono, envelope.length]);

    const key = mark(pk, session, counter);
    if (Object.hasOwn(this.durable.stored, key)) {
      if (this.durable.stored[key].sha256 !== digest) throw new CarryRefused("carry_counter_reused");
      return ["duplicate", receipt(), got];
    }
    const { incoming } = this.durable;
    let record = Object.hasOwn(incoming, pair) ? incoming[pair] : null;
    let isNew = false;
    const bound = Boolean(got.flags & carry.BOUND);
    if (bound && !record) {
      // carry.read found N in a challenge that waits in its window, and the message is signed over it as an open is: it
      // opens the session as the open would, with the same t0 (A6.2 point 6, decided 17 November 2026). Over sound the
      // open was lost in collisions, and the session with it, while the messages behind it came.
      record = this.#opened(pk, pair, this.waiting.get(pair), profileIn, t);
    }
    if (!bound && Object.hasOwn(this.durable.outgoing, pair)) throw new CarryRefused("carry_wrong_direction");
    if (!bound) {
      if (record && record.challenged) throw new CarryRefused("carry_binding_mismatch");
      if (!record) {
        if (!profileIn.acceptUnchallenged) throw new CarryRefused("carry_session_unknown");
        record = { challenged: false, nonce: null, highest: 0, closed: false, deadline, opened: null, closed_at: null, lifetime: null };
        isNew = true;
      }
    }
    if (record.closed) throw new CarryRefused("carry_session_closed");
    if (record.challenged) {
      const t0 = this.anchors.get(pair);
      if (t0 === undefined || mono - t0 > Math.min(record.lifetime, profileIn.lifetime)) throw new CarryRefused("carry_session_expired");
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
    // A new session without a challenge adds its record and its used id, and every message its mark.
    this.#room(pk, isNew ? 3 : 1);
    record.highest = Math.max(record.highest, counter);
    incoming[pair] = record;
    if (isNew) this.used.add(pair);
    // How it came and when, kept with it: what read says of it does not depend on a profile that may change meanwhile.
    this.durable.stored[key] = { sha256: digest, content: toHex(got.content), sealed: got.mode === carry.SEALED, at: t };
    this.#save();
    return ["accepted", receipt(), got];
  }

  // ----------------------------------------------------------- deleting

  /** Delete what A6.9 allows at this time, by the time floor and each session's own lifetime, and nothing more. */
  prune(now) {
    this.#check();
    const floor = this.#tick(now);
    for (const [pair, record] of Object.entries(this.durable.incoming)) {
      const gone = record.challenged
        ? floor > Math.max(record.opened + record.lifetime, record.closed_at ?? 0) + HORIZON
        : floor > record.deadline + SKEW;
      // A message the program has not taken stays until handedOver says it has it, and its session with it, since a
      // kept message belongs to a session kept. Deleted with the guard against replays, a message a receipt had said
      // was kept was gone (the follow-up check of 15 November 2026).
      if (gone && Object.entries(this.durable.stored).some(([key, entry]) => key.startsWith(pair + ":") && entry.content !== null)) continue;
      if (gone) {
        delete this.durable.incoming[pair];
        this.used.delete(pair);
        this.anchors.delete(pair);
        for (const key of Object.keys(this.durable.stored)) if (key.startsWith(pair + ":")) delete this.durable.stored[key];
      }
    }
    this.#save();
  }
}
