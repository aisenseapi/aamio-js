// One transport at work, for Node: frames in and out, envelopes delivered, receipts awaited.
//
// A Carrier joins a running TransportProcess to the home's CarryState for the
// partners bound to that transport, under one security profile. What comes in
// is put together from its frames and given to the state, which decides; what
// the state answers goes back to the address it came from.
//
// A message is sent again with the same bytes until its receipt comes; it is
// never sealed again or moved to another session, so a copy is known as one.
// The challenge and the open are sent again with the same bytes through the
// challenge window, since on a medium that loses frames one try is not enough;
// an ask no challenge answers is asked again with a new session.

import { performance } from "node:perf_hooks";
import * as carry from "./carry.js";
import { CarryRefused } from "./carry.js";
import { Reassembly } from "./node-transport-host.js";

export const UNVERIFIED_PER_SECOND = 20;
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const pairOf = (pk, session) => toHex(pk) + ":" + toHex(session);

export class Carrier {
  constructor(state, process, profile, known, { clock = () => performance.now() / 1000, wall = () => Math.floor(Date.now() / 1000), log = () => {},
    retrySeconds = 2, askRetrySeconds = 5, tries = 30 } = {}) {
    Object.assign(this, { state, process, profile, known, clock, wall, log, retrySeconds, askRetrySeconds, tries });
    this.reassembly = new Reassembly(clock);
    this.frameLimit = process.properties.max_frame_up;
    this.queue = [];
    this.waiting = new Map();
    this.asks = new Map();
    this.answered = new Map();   // pair -> [partner pk, session]
    this.addresses = new Map();  // partner pk in hex -> the transport address it was last heard from
    this.inbox = [];             // [sender pk, session, counter, content]
    this.refused = [];
    this.budget = UNVERIFIED_PER_SECOND;
    this.budgetAt = clock();
    this.counter = 0;
  }

  #queue(envelope, to) {
    this.queue.push([carry.split(envelope, this.frameLimit), to]);
  }

  #await(envelope, to, kind, pk, session, counter = null, most = null) {
    this.counter += 1;
    const key = `e-${this.counter}`;
    this.waiting.set(key, { envelope, to, next: this.clock() + this.retrySeconds, tries: 1, kind, pk, session, counter, most: most ?? this.tries });
    this.#queue(envelope, to);
    return key;
  }

  #windowTries() {
    return Math.max(1, Math.floor(this.profile.challengeWindow / this.retrySeconds));
  }

  /** Ask the partner for a session of this party's: the challenge and the open follow in pump. */
  open(partnerPk) {
    const [session, envelope] = this.state.ask(partnerPk, this.profile, this.clock());
    this.asks.set(pairOf(partnerPk, session), { pk: partnerPk, session, next: this.clock() + this.askRetrySeconds, tries: 1 });
    this.#queue(envelope, this.addresses.get(toHex(partnerPk)) ?? null);
    return session;
  }

  /** The newest session of this party's with the partner that a challenge has answered, or null. */
  openSession(partnerPk) {
    let found = null;
    for (const [pk, session] of this.answered.values()) if (carry.equal(pk, partnerPk)) found = session;
    return found;
  }

  /** A message in an open session, sent again with the same bytes until its receipt comes: its id. */
  send(partnerPk, session, content, deadline = 0) {
    const envelope = this.state.send(partnerPk, session, content, this.profile, { deadline });
    return this.#await(envelope, this.addresses.get(toHex(partnerPk)) ?? null, "message", partnerPk, session, this.state.counterOf(partnerPk, session));
  }

  confirmed(key) {
    return !this.waiting.has(key);
  }

  /** Read what the transport said, deliver what is whole, resend what waits, and give frames within the room. */
  async pump(timeoutMs = 50) {
    for (const event of await this.process.poll(timeoutMs)) {
      if (event[0] === "received") this.#received(event[1], event[2]);
    }
    this.#resend();
    this.#flush();
    this.process.checkTime();
  }

  #received(source, frame) {
    let envelope;
    try {
      envelope = this.reassembly.add(frame);
    } catch (error) {
      if (!(error instanceof CarryRefused)) throw error;
      this.refused.push(error.code);
      return;
    }
    if (envelope === null) return;
    const now = this.clock();
    this.budget = Math.min(UNVERIFIED_PER_SECOND, this.budget + (now - this.budgetAt) * UNVERIFIED_PER_SECOND);
    this.budgetAt = now;
    if (this.budget < 1) {
      this.refused.push("unverified_over_budget");
      return;
    }
    this.budget -= 1;
    let result, reply, got;
    try {
      [result, reply, got] = this.state.deliver(envelope, this.known, this.profile, now, this.wall());
    } catch (error) {
      if (!(error instanceof CarryRefused)) throw error;
      // Refusals stay here (A7): logged and counted, never answered over the medium.
      this.refused.push(error.code);
      return;
    }
    if (source !== null) this.addresses.set(toHex(got.sender), source);
    const pair = pairOf(got.sender, got.session);
    if (got.kind === carry.CHALLENGE) {
      this.asks.delete(pair);
      this.answered.set(pair, [got.sender, got.session]);
      this.#await(reply, source, "open", got.sender, got.session, null, this.#windowTries());
      return;
    }
    if (got.kind === carry.OPEN) {
      this.#settled(pair, "challenge");
      return;
    }
    if (got.kind === carry.ASK) {
      this.#await(reply, source, "challenge", got.sender, got.session, null, this.#windowTries());
      return;
    }
    if (got.kind === carry.RECEIPT) {
      const counter = ((got.content[9] << 24) >>> 0) + (got.content[10] << 16) + (got.content[11] << 8) + got.content[12];
      for (const [key, entry] of this.waiting) {
        if (pairOf(entry.pk, entry.session) === pair && (entry.kind === "open" || entry.counter === counter)) this.waiting.delete(key);
      }
      return;
    }
    if (got.kind === carry.MESSAGE && result === "accepted") this.inbox.push([got.sender, got.session, got.counter, got.content]);
    if (reply) this.#queue(reply, source);
  }

  #settled(pair, kind) {
    for (const [key, entry] of this.waiting) if (pairOf(entry.pk, entry.session) === pair && entry.kind === kind) this.waiting.delete(key);
  }

  #resend() {
    const now = this.clock();
    for (const [key, entry] of this.waiting) {
      if (now < entry.next) continue;
      if (entry.tries >= entry.most) {
        // The outcome stays unknown; nothing is wrapped again or sent as a new message on its own.
        this.waiting.delete(key);
        continue;
      }
      entry.tries += 1;
      entry.next = now + this.retrySeconds;
      this.#queue(entry.envelope, this.addresses.get(toHex(entry.pk)) ?? entry.to);
    }
    for (const [pair, entry] of [...this.asks]) {
      if (now < entry.next) continue;
      this.asks.delete(pair);
      if (entry.tries < this.tries) {
        const [session, envelope] = this.state.ask(entry.pk, this.profile, now);
        this.asks.set(pairOf(entry.pk, session), { pk: entry.pk, session, next: now + this.askRetrySeconds, tries: entry.tries + 1 });
        this.#queue(envelope, this.addresses.get(toHex(entry.pk)) ?? null);
      }
    }
  }

  #flush() {
    while (this.queue.length && this.process.room() > 0) {
      const [frames, to] = this.queue[0];
      const frame = frames.shift();
      if (this.process.send(frame, to) === null) {
        frames.unshift(frame);
        return;
      }
      if (frames.length === 0) this.queue.shift();
    }
  }
}
