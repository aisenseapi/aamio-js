// One transport at work, for Node: frames in and out, envelopes delivered, receipts awaited.
//
// A Carrier joins a running TransportProcess to the home's CarryState for the
// partners bound to that transport, under one security profile or one per
// partner (B5). What comes in
// is put together from its frames and given to the state, which decides; what
// the state answers goes back to the address it came from.
//
// A message is known by its mark (partner, session and counter), which outlives
// the process. It is sent again with the same bytes until its receipt comes; it
// is never sealed again or moved to another session, so a copy is known as one.
// The bytes and the tries are kept in the state, so a carrier on the same home
// after a restart goes on with the same bytes and the tries that are left. It is
// confirmed only when its receipt comes: when the tries run out without one, its
// outcome is unknown, since it may still have arrived, and it is never reported
// as confirmed. Bytes written under another mode than the partner's profile has
// now are not sent at all (B5): the message is given up, and the user is told.
//
// What came in is the state's until the program says it has it: inbox is what
// the state keeps that the program has not taken, read as often as needed, and
// take(mark) says the program has it. A crash before take offers it again.
//
// The challenge and the open are sent again with the same bytes through the
// challenge window, since on a medium that loses frames one try is not enough;
// an ask no challenge answers is asked again with a new session.

import { performance } from "node:perf_hooks";
import * as carry from "./carry.js";
import { CarryRefused } from "./carry.js";
import { mark, TRIES_DEFAULT } from "./node-carry-state.js";
import { Reassembly } from "./node-transport-host.js";

export const UNVERIFIED_PER_SECOND = 20;
// A receipt, a challenge or an open, sealed, is under 200 bytes: 192, 163 and 163. An ask is 147.
export const ANSWER_BYTES = 200;
// What a sealed message adds to its content, rounded up: 262 bytes carry a body of about 110.
export const MESSAGE_BYTES = 160;
// On a slow medium a turn is longer by a random part of up to half of it: two that began together, as two that both ask
// for a session at once, and lost each other's frames, would otherwise try again together for good.
export const JITTER = 0.5;
// How much longer than the bare time on the medium a wait gives: a half-duplex medium takes turns, and what is heard has
// to be read before it is answered.
export const SLACK = 2;
// A session a message went this many tries in without a receipt, with no later message in it confirmed, takes no new
// message: the partner may have started again and taken it as expired (A6.8), and what it refuses is never answered over
// the medium (A7), so every message after would be lost in it too. The next one asks for a new session.
export const UNANSWERED_TRIES = 3;
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const pairOf = (pk, session) => toHex(pk) + ":" + toHex(session);

export class Carrier {
  constructor(state, process, profile, known, { clock = () => performance.now() / 1000, wall = () => Math.floor(Date.now() / 1000), log = () => {},
    retrySeconds = 2, askRetrySeconds = 5, tries = TRIES_DEFAULT, note = null } = {}) {
    Object.assign(this, { state, process, profile, known, clock, wall, log, retrySeconds, askRetrySeconds, tries });
    // What the user is to hear, as a message that is not sent again: where the runtime keeps attention, or the log.
    this.note = note ?? log;
    // One profile for every partner, or a function from a partner's key to its own (B5).
    this.profileOf = typeof profile === "function" ? profile : () => profile;
    this.given = new Map();      // mark -> the frame ids of each try that was given to the transport whole
    this.handed = new Set();     // marks one try of which the transport said it handed over whole (B6 1)
    const rateDown = process.properties.rate_down;
    const frameDown = process.properties.max_frame_down;
    const slow = typeof rateDown === "number" && rateDown > 0 && Number.isInteger(frameDown);
    this.reassembly = new Reassembly(clock, slow ? frameDown / rateDown : 0);
    this.frameLimit = process.properties.max_frame_up;
    // A full frame's time on the medium, as the transport's rate says, and what the waits are measured in where the
    // medium is slow. Over sound a frame is 16 seconds: a try every 2 seconds filled the air with copies of a message
    // whose receipt then had no turn, and a session could not be opened in the 30 seconds a send waited.
    const rate = process.properties.rate_up;
    this.frameSeconds = typeof rate === "number" && rate > 0 ? this.frameLimit / rate : 0;
    // A number from 0 up to 1, for the random part of a turn; a property, so a test can fix it.
    this.random = Math.random;
    this.queue = [];
    this.messages = new Map();   // mark -> { envelope, pk, session, next }: sent, and its receipt not come
    this.control = new Map();    // id -> challenges and opens sent again through the window
    this.asks = new Map();
    this.answered = new Map();   // pair -> [partner pk, session, when its challenge came], in that order
    this.addresses = new Map();  // partner pk in hex -> the transport address it was last heard from
    this.refused = [];
    this.budget = UNVERIFIED_PER_SECOND;
    this.budgetAt = clock();
    this.counter = 0;
    const knownSet = new Set(known.map(toHex));
    for (const [key, pk, session, , envelope] of state.unconfirmed()) {
      // Sent before this process started: taken up with the same bytes and the tries that are left, when they were
      // written as the partner's profile says now (B5).
      if (knownSet.has(toHex(pk)) && this.#fitsProfile(key, pk, envelope)) this.messages.set(key, { envelope, pk, session, next: clock() });
    }
  }

  /**
   * Whether bytes written earlier may go on under the partner's profile now, given up and said when they may not.
   *
   * Readable bytes taken up after the partner's profile became sealed went out readable (the follow-up check of 15
   * November 2026). A message is never sealed again under its mark, so it is given up: its mark and hash stay for a late
   * receipt, and its outcome is unknown, since an earlier try may have arrived.
   */
  #fitsProfile(key, pk, envelope) {
    const mode = this.profileOf(pk).mode;
    if (envelope[4] === (mode === "sealed" ? carry.SEALED : carry.READABLE)) return true;
    this.state.giveUp(key);
    this.note(`${key} was written ${envelope[4] === carry.READABLE ? "readable" : "sealed"}, and the profile for that partner is ${mode} now, so it is not sent again: B5 sends no message under another mode. `
      + `Its outcome is unknown, since an earlier try may have arrived; send it again as a new message to have it go ${mode}.`);
    return false;
  }

  /** Whether a try at the message waits in the queue, not one frame of it given to the transport yet. */
  #queued(key) {
    return this.queue.some(([, , queued, ids]) => queued === key && ids.length === 0);
  }

  /**
   * An envelope in frames, waiting for room. counted says whether the try it is has been counted in the state: the
   * first try of a message is, when the message is written, and a later one is counted as it begins.
   */
  #queue(envelope, to, key = null, counted = true) {
    this.queue.push([carry.split(envelope, this.frameLimit), to, key, [], counted]);
  }

  /** How many frames size bytes take on this medium. */
  #frames(size) {
    return Math.ceil(size / Math.max(1, this.frameLimit - carry.FRAME_HEADER));
  }

  /** The bare time size bytes take on the medium, as the transport's rate says; nothing on a fast medium. */
  #airtime(size) {
    return this.frameSeconds * this.#frames(size);
  }

  /**
   * How long to wait for the answer to an envelope before it goes again: base, or on a slow medium the time the envelope
   * and what answers it take there, with slack. A fast medium never reaches base.
   */
  #turn(envelope, base) {
    const slow = SLACK * this.frameSeconds * (this.#frames(envelope.length) + this.#frames(ANSWER_BYTES));
    return slow <= base ? base : slow * (1 + JITTER * this.random());
  }

  /** What a challenge and its open take on this medium, with slack: what a profile's challenge window has to give. */
  handshakeSeconds() {
    return SLACK * this.frameSeconds * 2 * this.#frames(ANSWER_BYTES);
  }

  /** A challenge's and its open's time on this medium, at most: every frame counted as a full one. */
  airtimeOfHandshake() {
    return 2 * this.#airtime(ANSWER_BYTES);
  }

  /**
   * A challenge window in which an open has tries chances to come through on this medium, the longest turns counted:
   * what a profile for a slow medium is to give. A lost open loses its session.
   */
  windowForOpens(tries = 3) {
    const turn = SLACK * this.frameSeconds * 2 * this.#frames(ANSWER_BYTES) * (1 + JITTER);
    return 2 * this.#airtime(ANSWER_BYTES) + (tries - 1) * turn;
  }

  /**
   * How long a send of size bytes of content takes on this medium when nothing is lost: an ask, its challenge and the
   * open, the message and its receipt, with slack. Next to nothing on a fast medium.
   */
  patience(size) {
    return SLACK * this.frameSeconds * (4 * this.#frames(ANSWER_BYTES) + this.#frames(size + MESSAGE_BYTES));
  }

  /**
   * A challenge or an open, sent again with the same bytes one turn after it went, as long as it can still arrive in the
   * challenge window: a try that began later would come after the window, and be turned down, so it is left out.
   *
   * An open goes again on the same turn as a challenge, though the first receipt in its session is what shows it came:
   * waiting for the message behind it and that message's receipt as well, an open over sound had two tries within a
   * window of 60 seconds at eight times real time, and when both were lost, so was the session (16 November 2026).
   */
  #control(envelope, to, kind, pk, session, most, window) {
    const at = this.clock();
    this.counter += 1;
    this.control.set(`c-${this.counter}`, { envelope, to, kind, pk, session, next: at + this.#turn(envelope, this.retrySeconds), tries: 1, most,
      until: at + window - this.#airtime(ANSWER_BYTES) });
    this.#queue(envelope, to);
  }

  #windowTries(pk) {
    // A challenge goes again one turn after it went, a turn being as long as a challenge and its open take.
    return Math.max(1, Math.floor(this.profileOf(pk).challengeWindow / Math.max(this.retrySeconds, SLACK * this.frameSeconds * 2 * this.#frames(ANSWER_BYTES))));
  }

  /** Ask the partner for a session of this party's: the challenge and the open follow in pump. */
  open(partnerPk) {
    const [session, envelope] = this.state.ask(partnerPk, this.profileOf(partnerPk), this.clock());
    this.asks.set(pairOf(partnerPk, session), { pk: partnerPk, session, next: this.clock() + this.#turn(envelope, this.askRetrySeconds), tries: 1 });
    this.#queue(envelope, this.addresses.get(toHex(partnerPk)) ?? null);
    return session;
  }

  /** Whether an ask for a session with the partner is under way: sent, and gone again on its own until answered. */
  asking(partnerPk) {
    for (const entry of this.asks.values()) if (carry.equal(entry.pk, partnerPk)) return true;
    return false;
  }

  /** The newest session of this party's with the partner that a challenge has answered, or null. */
  openSession(partnerPk) {
    let found = null;
    for (const [pk, session] of this.answered.values()) if (carry.equal(pk, partnerPk)) found = session;
    return found;
  }

  /**
   * The newest session of this party's with the partner whose challenge came less than seconds ago, or null. Null too when
   * a message in it went UNANSWERED_TRIES tries without a receipt and nothing later in it was confirmed (A7): the next
   * message asks for a new session.
   */
  usableSession(partnerPk, seconds) {
    let found = null;
    const now = this.clock();
    for (const [pk, session, at] of this.answered.values()) if (carry.equal(pk, partnerPk) && now - at < seconds) found = session;
    if (found !== null && this.state.unanswered(partnerPk, found, UNANSWERED_TRIES)) return null;
    return found;
  }

  /** Seconds until the answer to the ask under way with the partner is due on this medium, or null without one. */
  askDue(partnerPk) {
    const due = [...this.asks.values()].filter((entry) => carry.equal(entry.pk, partnerPk)).map((entry) => entry.next);
    return due.length === 0 ? null : Math.max(0, Math.min(...due) - this.clock());
  }

  /** A message in an open session, sent again with the same bytes until its receipt comes: its mark. */
  send(partnerPk, session, content, deadline = 0) {
    const envelope = this.state.send(partnerPk, session, content, this.profileOf(partnerPk), { deadline, most: this.tries });
    const key = mark(partnerPk, session, this.state.counterOf(partnerPk, session));
    this.messages.set(key, { envelope, pk: partnerPk, session, next: this.clock() + this.#turn(envelope, this.retrySeconds) });
    this.#queue(envelope, this.addresses.get(toHex(partnerPk)) ?? null, key);
    return key;
  }

  /** B6 1: the transport said sent for every frame of one try at the message, in this process. Nothing about receipt. */
  handedOver(key) {
    if (this.handed.has(key)) return true;
    for (const ids of this.given.get(key) ?? []) {
      if (ids.length && ids.every((id) => this.process.status(id) === "sent")) {
        this.handed.add(key);
        this.given.delete(key);
        return true;
      }
    }
    return false;
  }

  /** Whether frames wait here for the transport, or wait at the transport for an answer. */
  busy() {
    return this.queue.length > 0 || this.process.waiting() > 0;
  }

  /** True only when the receipt came; never for a message whose tries ran out without one. */
  confirmed(key) {
    return this.state.outcome(key) === "confirmed";
  }

  /** waiting while it is sent again, confirmed when its receipt came, and unknown when the tries ran out without one. */
  outcome(key) {
    return this.state.outcome(key);
  }

  /** What came and is kept that the program has not taken: [sender pk, session, counter, content, mark], in order. */
  get inbox() {
    return this.state.pending().map(([key, pk, session, counter, content]) => [pk, session, counter, content, key]);
  }

  /** The program has the message: the state keeps only its mark from now on. */
  take(key) {
    this.state.handedOver(key);
  }

  /** Read what the transport said, deliver what is whole, resend what waits, and give frames within the room. */
  async pump(timeoutMs = 50) {
    for (const event of await this.process.poll(timeoutMs)) {
      if (event[0] === "received") this.#received(event[1], event[2]);
      else if (event[0] === "status") this.log(`transport ${this.process.name}: ${event[1]} ${event[2]}`);
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
    let reply, got;
    try {
      [, reply, got] = this.state.deliver(envelope, this.known, this.profileOf, now, this.wall());
    } catch (error) {
      if (!(error instanceof CarryRefused)) throw error;
      // Refusals stay here (A7): logged and counted, never answered over the medium.
      this.refused.push(error.code);
      return;
    }
    if (source !== null) this.addresses.set(toHex(got.sender), source);
    const pair = pairOf(got.sender, got.session);
    if (got.kind === carry.CHALLENGE) {
      // A session with the partner is open: every ask to it ends, the one this answers and any made since. Asked again on
      // a slow medium, each took turns from the messages it was asked for.
      for (const [asked, entry] of [...this.asks]) if (carry.equal(entry.pk, got.sender)) this.asks.delete(asked);
      if (!this.answered.has(pair)) this.answered.set(pair, [got.sender, got.session, now]);
      // The open is sent again with the same bytes through the challenge window, until the first receipt in the session
      // shows it came: on a medium that loses frames, one try is not enough. The window was counted from before the
      // challenge went, so the challenge's own time on the medium is off it.
      const window = this.profileOf(got.sender).challengeWindow;
      this.#control(reply, source, "open", got.sender, got.session, this.#windowTries(got.sender), window - this.#airtime(ANSWER_BYTES));
      return;
    }
    if (got.kind === carry.OPEN) {
      this.#settled(pair, "challenge");
      return;
    }
    if (got.kind === carry.ASK) {
      // The challenge too is sent again with the same bytes until its open comes, or the window is gone; a try is left out
      // when the challenge and its open could no longer come through within it.
      const window = this.profileOf(got.sender).challengeWindow;
      this.#control(reply, source, "challenge", got.sender, got.session, this.#windowTries(got.sender), window - this.#airtime(ANSWER_BYTES));
      return;
    }
    if (got.kind === carry.RECEIPT) {
      const counter = ((got.content[9] << 24) >>> 0) + (got.content[10] << 16) + (got.content[11] << 8) + got.content[12];
      this.messages.delete(mark(got.sender, got.content.slice(1, 9), counter));
      this.#settled(pair, "open");
      return;
    }
    // A message: its receipt goes back. A bound one may have opened its session itself, its open lost (A6.2 point 6), so the
    // challenge is not sent again either.
    this.#settled(pair, "challenge");
    if (reply) this.#queue(reply, source);
  }

  #settled(pair, kind) {
    for (const [key, entry] of this.control) if (pairOf(entry.pk, entry.session) === pair && entry.kind === kind) this.control.delete(key);
  }

  #resend() {
    const now = this.clock();
    for (const [key, entry] of this.messages) {
      if (now < entry.next) continue;
      if (this.#queued(key)) {
        // The last try still waits for room: a try is counted when it can be given to the transport, not while copies
        // pile up behind one that has not gone.
        entry.next = now + this.retrySeconds;
        continue;
      }
      if (!this.#fitsProfile(key, entry.pk, entry.envelope)) {
        this.messages.delete(key);
        continue;
      }
      if (this.state.triesLeft(key) === 0) {
        // The tries are used: the bytes go, and the outcome is unknown for good (A7).
        this.state.tried(key);
        this.log(`no receipt for ${key}, and its tries are used`);
        this.messages.delete(key);
        continue;
      }
      entry.next = now + this.#turn(entry.envelope, this.retrySeconds);
      // Queued, the try has used nothing: it is counted as it begins, in #flush, when it can be given to the
      // transport. Counted here, every new owner used a try as it took the outbox up, room or not, and a budget went
      // with nothing sent (the check of 16 November 2026).
      this.#queue(entry.envelope, this.addresses.get(toHex(entry.pk)) ?? null, key, false);
    }
    for (const [key, entry] of this.control) {
      if (now < entry.next) continue;
      if (entry.tries >= entry.most || now > entry.until) {
        this.control.delete(key);
        continue;
      }
      entry.tries += 1;
      entry.next = now + this.#turn(entry.envelope, this.retrySeconds);
      this.#queue(entry.envelope, this.addresses.get(toHex(entry.pk)) ?? entry.to);
    }
    for (const [pair, entry] of [...this.asks]) {
      if (now < entry.next) continue;
      this.asks.delete(pair);
      if (entry.tries < this.tries) {
        const [session, envelope] = this.state.ask(entry.pk, this.profileOf(entry.pk), now);
        this.asks.set(pairOf(entry.pk, session), { pk: entry.pk, session, next: now + this.#turn(envelope, this.askRetrySeconds), tries: entry.tries + 1 });
        this.#queue(envelope, this.addresses.get(toHex(entry.pk)) ?? null);
      }
    }
  }

  #flush() {
    while (this.queue.length && this.process.room() > 0) {
      const [frames, to, key, ids, counted] = this.queue[0];
      if (key !== null && ids.length === 0) {
        // A try at a message begins here, so here is where it may still be stopped: when the message is over (its
        // receipt came, or its tries are used), or when the partner's profile is of another mode now than the bytes
        // were written under. Queued earlier, it went out all the same once there was room.
        const entry = this.messages.get(key);
        if (!entry || !this.#fitsProfile(key, entry.pk, entry.envelope)) {
          this.messages.delete(key);
          this.queue.shift();
          continue;
        }
        if (!counted) {
          // Counted in the state before its first frame goes, so a restart never gives back a try that was used,
          // and counted only now that there is room for it.
          if (!this.state.tried(key)) {
            this.log(`no receipt for ${key}, and its tries are used`);
            this.messages.delete(key);
            this.queue.shift();
            continue;
          }
          this.queue[0][4] = true;
        }
        // The next try is one turn after this one began, however long it waited for room.
        entry.next = this.clock() + this.#turn(entry.envelope, this.retrySeconds);
      }
      const frame = frames.shift();
      const id = this.process.send(frame, to);
      if (id === null) {
        frames.unshift(frame);
        break;
      }
      ids.push(id);
      if (frames.length === 0) {
        this.queue.shift();
        if (key !== null && !this.handed.has(key)) this.given.set(key, [...(this.given.get(key) ?? []), ids]);
      }
    }
    // The host measures how long frames wait for room (B3.2), so it is told whether any do.
    this.process.waitingForRoom(this.queue.length > 0);
  }
}
