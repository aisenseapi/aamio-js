import { open, readFile, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Aamio, AamioError, DEFAULT_BASE, GateStop, checkMessage, gatePlan, isEnvelope, isKey, keyHash, sha256hex, threadSigningInput } from "./aamio.js";
import { readKeys } from "./node-identity.js";
import { takeHome } from "./node-lock.js";

/*
 * The local runtime for Node: a home held for as long as it runs, an inbox the
 * partners can write to, presence that says where it is, sends written to an
 * outbox before they go, and reads checked here before anything is handed on.
 *
 * A home is shared with aamio-python and aamio-php, so the files are theirs:
 * partners.json, state.json and outbox.json in the same shape, written the same
 * way. A home one of them made opens here, and one this makes opens there. What
 * Python keeps that this does not touch yet, scopes, traces, effects and the
 * archive, is left as it is.
 */

export const INBOX_TTL = 3600;
export const PRESENCE_TTL = 120;
export const PRESENCE_REFRESH = 60;
export const RENEW_BEFORE = 180;
export const MESSAGE_MAX_BYTES = 65536;

// Files this runtime writes back. One that is there and cannot be read stops
// the runtime before anything is saved over it: a save is how a broken file
// becomes a lost one.
const KEPT_FILES = ["partners.json", "state.json", "outbox.json"];
// Answers that prove a message was not stored: refusals the service will give
// again, and a rate window, which it decides before it reads the body.
const SEND_DETERMINISTIC = [400, 403, 410, 413, 415, 422, 428, 501];
const SEND_NOT_STORED = [...SEND_DETERMINISTIC, 429];
const HASH = /^[0-9a-f]{64}$/;
const ADDRESS = /^[a-z2-7]{20}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;

function runtimeError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What a message was made of, for the outbox, without what it said. The same fields aamio-python records. */
function messageShape(body, envelope) {
  const shape = { bytes: Buffer.byteLength(envelope, "utf8"), fields: Object.keys(body).sort(), text_chars: typeof body.text === "string" ? [...body.text].length : null };
  for (const field of ["re", "seen"]) if (HASH.test(body[field] ?? "")) shape[field] = body[field];
  return shape;
}

export class NodeRuntime {
  /** Takes the home, reads its key and its files. Close it to let go. */
  static async open({ home, host = process.env.AAMIO_HOST || DEFAULT_BASE, fetch = globalThis.fetch, clock = () => Date.now() / 1000 } = {}) {
    const owner = await takeHome(home, { host });
    try {
      const runtime = new NodeRuntime({ home, host, keys: await readKeys(home), owner, fetch, clock });
      await runtime.load();
      return runtime;
    } catch (error) {
      await owner.release();
      throw error;
    }
  }

  constructor({ home, host, keys, owner, fetch, clock }) {
    this.home = home;
    this.host = host.replace(/\/+$/, "");
    this.keys = keys;
    this.owner = owner;
    this.clock = clock;
    this.client = new Aamio({ base: this.host, keys, fetch });
    this.attention = [];
    this.presenceAt = 0;
    this.presenceFailed = false;
    this.presenceRetryAt = 0;
    this.closed = false;
    this.queue = Promise.resolve();
  }

  /**
   * fn run when everything queued before it has finished. A server answers one
   * call at a time and refreshes presence on a timer, and two of them changing
   * the inbox at once could each open one: so they take turns.
   */
  serial(fn) {
    const turn = this.queue.then(() => fn());
    this.queue = turn.catch(() => {});
    return turn;
  }

  now() {
    return this.clock();
  }

  // ------------------------------------------------------------- files --

  async loadJson(name, fallback, valid) {
    let bytes;
    try {
      bytes = await readFile(join(this.home, name));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw runtimeError("state_unreadable", `${name} in ${this.home} is there and cannot be read (${error.code || error.message}), so nothing is saved over it. Restore it from a copy, or move it aside.`);
    }
    let text;
    try {
      // Fatal: a byte that is not UTF-8 makes the file unreadable. Read with
      // replacement characters, a name in it would be saved back changed.
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw runtimeError("state_unreadable", `${name} in ${this.home} is not UTF-8, so nothing is saved over it. Restore it from a copy, or move it aside.`);
    }
    if (text.trim() === "") return fallback;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw runtimeError("state_unreadable", `${name} in ${this.home} is not JSON, so nothing is saved over it. Restore it from a copy, or move it aside.`);
    }
    if (!valid(value)) throw runtimeError("state_unreadable", `${name} in ${this.home} does not hold what it should, so nothing is saved over it. Restore it from a copy, or move it aside.`);
    return value;
  }

  async load() {
    this.partnersFile = await this.loadJson("partners.json", [], Array.isArray);
    this.state = await this.loadJson("state.json", {}, isObject);
    this.outbox = await this.loadJson("outbox.json", {}, isObject);
    if (!Array.isArray(this.state.tags)) this.state.tags = [];
    if (!isObject(this.state.peers)) this.state.peers = {};
    if (!Array.isArray(this.state.channels)) this.state.channels = [];
    for (const channel of this.state.channels) {
      if (!isObject(channel)) continue;
      channel.seen = Array.isArray(channel.seen) ? channel.seen.filter((value) => typeof value === "string" && HASH.test(value)) : [];
      channel.allow = Array.isArray(channel.allow) ? channel.allow : [];
      if (!Number.isInteger(channel.after)) channel.after = 0;
    }
    await this.settleInterrupted();
  }

  /**
   * What a process that stopped left in the outbox, settled by the rules
   * aamio-python uses, so a shared home says the same in both. A send in
   * flight may have landed: unknown. Work for a gate comes before the post, so
   * work that never finished was never sent: stopped, unless an earlier
   * attempt had already left. Each is said once, on this process's first read.
   */
  async settleInterrupted() {
    let changed = false;
    for (const entry of Object.values(this.outbox)) {
      if (!isObject(entry)) continue;
      if (["sending", "unknown", "refused", "delivered"].includes(entry.status) && entry.posting !== true) {
        entry.posting = true;
        changed = true;
      }
      if (entry.status === "sending") {
        entry.status = "unknown";
        entry.note = "the process stopped while this was in flight";
        changed = true;
      } else if (entry.status === "working") {
        entry.status = entry.posting ? "unknown" : "stopped";
        entry.note = entry.posting
          ? "the process stopped while a retry was doing its proof of work. An earlier attempt had already left this machine and its answer never came, so the outcome is still unknown"
          : "the process stopped before its proof of work was done, so nothing was sent";
        changed = true;
      }
      if (["attempted", "unknown"].includes(entry.status) && entry.ever_open !== true) {
        entry.ever_open = true;
        changed = true;
      }
      if (entry.note && !entry.told && ["unknown", "stopped"].includes(entry.status)) {
        this.note(`send ${entry.id}`, entry.status, entry.status === "stopped"
          ? `the message to ${entry.w} was not sent: ${entry.note}. Send it again if it still matters.`
          : `the message to ${entry.w} may have arrived: ${entry.note}. Its outcome is open: do not compose a replacement.`);
        entry.told = true;
        changed = true;
      }
    }
    if (!changed) return;
    try {
      await this.saveOutbox();
    } catch (error) {
      this.note("outbox", "not_saved", `the outbox could not be saved after settling what the last process left (${error.code || error.message}); it is settled again next time`);
    }
  }

  /** A file of this home, private from its first byte, replaced in one step and only over bytes that reached the disk. */
  async saveJson(name, value) {
    if (this.closed) throw runtimeError("runtime_closed", `${name} not written: this runtime has let go of ${this.home}`);
    const path = join(this.home, name);
    const temporary = join(this.home, `${name}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    if (process.platform !== "win32") {
      const folder = await open(this.home, constants.O_RDONLY);
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
    }
  }

  saveState() {
    return this.saveJson("state.json", this.state);
  }

  saveOutbox() {
    return this.saveJson("outbox.json", this.outbox);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.owner.release();
  }

  // ---------------------------------------------------------- partners --

  get partners() {
    return this.partnersFile.filter((p) => isObject(p) && typeof p.name === "string" && typeof p.key === "string");
  }

  /**
   * The partner with this name: the one so named exactly, or the only one so
   * named apart from upper and lower case. Two of those, and no exact one, is
   * an error, never a guess: a guess seals the message to the wrong key.
   */
  partnerByName(name) {
    const partners = this.partners;
    const exact = partners.find((p) => p.name === String(name));
    if (exact) return exact;
    const folded = partners.filter((p) => p.name.toLowerCase() === String(name).toLowerCase());
    if (folded.length > 1) {
      throw runtimeError("ambiguous_partner", `${folded.length} partners are called ${name} apart from upper and lower case (${folded.map((p) => p.name).join(", ")}). Give the name exactly as it is in the address book, or the key.`);
    }
    return folded[0] ?? null;
  }

  partnerByKey(key) {
    return this.partners.find((p) => p.key === key) ?? null;
  }

  nameForKey(key) {
    return key ? this.partnerByKey(key)?.name ?? null : null;
  }

  partnerList() {
    return this.partners.map((p) => ({ name: p.name, key: p.key, hash_prefix: keyHash(p.key).slice(0, 8) }));
  }

  /** A partner into the address book, and into the inbox at once: an inbox that does not name the key is replaced by one that does. */
  async partnerAdd(name, key) {
    if (typeof name !== "string" || !NAME.test(name)) throw runtimeError("invalid_name", "A partner's name is 1 to 64 characters, with no control characters.");
    if (!isKey(key)) throw runtimeError("invalid_key", "not a base64url Ed25519 public key of 32 bytes");
    const near = this.partners.find((p) => p.name !== name && p.name.toLowerCase() === name.toLowerCase() && p.key !== key);
    if (near) throw runtimeError("ambiguous_partner", `${near.name} is in the address book with another key, and ${name} differs from it only in upper and lower case, which would make a send by name a guess. Choose another name.`);
    this.partnersFile = this.partnersFile.filter((p) => !(isObject(p) && (p.name === name || p.key === key)));
    this.partnersFile.push({ name, key });
    await this.saveJson("partners.json", this.partnersFile);
    return this.inboxAfterChange(`partner ${name} was added`, { partner: name, key });
  }

  // ------------------------------------------------------------- inbox --

  channel(label) {
    return this.state.channels.find((c) => isObject(c) && c.label === label) ?? null;
  }

  wantedAllow() {
    const partners = this.partners;
    return partners.length ? partners.map((p) => p.key) : null;
  }

  inboxMatches(inbox, wanted) {
    const allow = inbox.allow || [];
    if (wanted === null) return allow.length === 0 || (allow.length === 1 && allow[0] === "*");
    return JSON.stringify([...allow].sort()) === JSON.stringify([...wanted].sort());
  }

  async inboxAfterChange(reason, outcome) {
    const inbox = this.channel("inbox");
    if (inbox === null) return { ...outcome, inbox: null, rotated: false };
    if (this.inboxMatches(inbox, this.wantedAllow())) return { ...outcome, inbox: inbox.w, rotated: false, expire_at: inbox.expire_at };
    return { ...outcome, ...(await this.rotateInbox(reason)) };
  }

  note(where, state, what, w = null) {
    this.attention.push({ channel: where, w, state, what, at: Math.floor(this.now()) });
  }

  /** What the reads since the last call could not do, once, and then cleared. */
  attentionTaken() {
    const taken = this.attention;
    this.attention = [];
    return taken;
  }

  /** A new inbox with the address book as it is now. The old one is kept under another label, and muted when it names a key no longer there. */
  async rotateInbox(reason) {
    const old = this.channel("inbox");
    let wanted = this.wantedAllow();
    // The last partner is gone: signed only, rather than open to anyone at an address the partners had.
    if (wanted === null && old && (old.allow || []).length) wanted = ["*"];
    let thread;
    try {
      thread = await this.client.open({ ttl: INBOX_TTL, allow: wanted ?? undefined });
    } catch (error) {
      const what = `the inbox could not be opened again after ${reason}: ${error.status ?? 0} ${JSON.stringify(error.body ?? error.message)}. The old inbox stays in use with its old list.`;
      this.note("inbox", "rotation_failed", what, old?.w ?? null);
      return { rotated: false, inbox: old?.w ?? null, error: what };
    }
    if (old) {
      const base = `inbox-${old.expire_at}`;
      let label = base;
      for (let suffix = 1; this.channel(label); suffix++) label = `${base}-${suffix}`;
      old.label = label;
    }
    const inbox = { label: "inbox", read_key: thread.id, w: thread.w, expire_at: thread.expireAt, allow: wanted ?? [], after: 0, created_at: null, gone: false, muted: false, seen: [] };
    this.state.channels.push(inbox);
    const muted = this.muteGenerations(reason);
    await this.saveState();
    const outcome = { rotated: true, inbox: inbox.w, allow: inbox.allow.map((key) => this.nameForKey(key) ?? key), expire_at: inbox.expire_at };
    if (old) outcome.old_inbox = { w: old.w, muted: old.muted, until: old.expire_at };
    if (muted.length) outcome.muted = muted;
    outcome.presence = await this.publishPresence(true);
    return outcome;
  }

  /** Every older inbox that names a key no longer in the address book is read no more. That is this side's delivery stopping, not a revocation. */
  muteGenerations(reason) {
    const partners = new Set(this.partners.map((p) => p.key));
    const muted = [];
    for (const channel of this.state.channels) {
      if (!isObject(channel) || channel.label === "inbox" || channel.muted || !String(channel.label).startsWith("inbox")) continue;
      const gone = (channel.allow || []).filter((key) => key !== "*" && !partners.has(key));
      if (!gone.length) continue;
      channel.muted = true;
      muted.push(channel.w);
      this.note(channel.label, "muted", `inbox ${channel.w} is read no more after ${reason}: ${gone.length} removed key(s) can still write there until ${channel.expire_at}, and nothing from there is delivered`, channel.w);
    }
    return muted;
  }

  /** The inbox, opened again when it is gone, about to expire, or no longer matches the address book. */
  async ensureInbox() {
    const inbox = this.channel("inbox");
    const usable = inbox !== null && inbox.expire_at - this.now() > RENEW_BEFORE && !inbox.gone;
    if (usable && this.inboxMatches(inbox, this.wantedAllow())) return inbox;
    const reason = usable ? "the address book changed" : inbox !== null && inbox.gone ? "the inbox was gone" : "renewal";
    const outcome = await this.rotateInbox(reason);
    if (outcome.rotated) return this.channel("inbox");
    if (inbox === null || inbox.gone || inbox.expire_at <= this.now()) throw runtimeError("inbox_unavailable", `could not open inbox: ${outcome.error}`);
    return inbox;
  }

  /** Where this runtime can be reached, for PRESENCE_TTL seconds. A failure is said, and tried again after a wait that doubles. */
  async publishPresence(force = false) {
    const now = this.now();
    if (!force && now - this.presenceAt < PRESENCE_REFRESH && !(this.presenceFailed && now >= this.presenceRetryAt)) return null;
    const inbox = this.channel("inbox");
    if (inbox === null) return null;
    this.presenceAt = now;
    try {
      await this.client.presence.publish({ w: inbox.w, tags: this.state.tags.slice(0, 8), ttl: PRESENCE_TTL });
    } catch (error) {
      this.presenceBackoff = Math.min(PRESENCE_REFRESH, Math.max(2, 2 * (this.presenceBackoff || 0)));
      this.presenceRetryAt = now + this.presenceBackoff;
      this.presenceFailed = true;
      this.note("presence", "presence_failed", `presence for inbox ${inbox.w} could not be published: ${error.status ?? 0}. A partner who looks you up is sent to the address published before, while that record lives. The next try is in ${this.presenceBackoff} seconds.`, inbox.w);
      return false;
    }
    this.presenceFailed = false;
    this.presenceBackoff = 0;
    return true;
  }

  whoami() {
    const inbox = this.channel("inbox");
    return { key: this.keys.public, hash: this.keys.hash, hash_prefix: this.keys.hash.slice(0, 8), inbox: inbox?.w ?? null, inbox_expires_at: inbox?.expire_at ?? null, host: this.host, tags: this.state.tags };
  }

  // ------------------------------------------------------------ lookup --

  /** Which partners are reachable now, and where. Each address found is bound to its key, so a send can be sealed to it. */
  async lookup(names = null, wait = 0) {
    const partners = names?.length ? this.partners.filter((p) => names.some((n) => String(n).toLowerCase() === p.name.toLowerCase())) : this.partners;
    return this.lookupPartners(partners, wait);
  }

  async lookupPartners(partners, wait = 0) {
    if (!partners.length) return { online: [], offline: [], error: "no partners to look up" };
    let matches;
    try {
      matches = await this.client.presence.lookup(partners.map((p) => p.key), { wait });
    } catch (error) {
      return { online: [], offline: partners.map((p) => p.name), error: `lookup failed: ${error.status ?? 0} ${JSON.stringify(error.body ?? error.message)}` };
    }
    const online = [];
    for (const match of matches) {
      const partner = this.partnerByKey(match.key);
      if (!partner || typeof match.w !== "string" || !ADDRESS.test(match.w)) continue;
      this.state.peers[match.w] = partner.key;
      online.push({ name: partner.name, key: partner.key, w: match.w, tags: match.tags ?? [], expires_at: match.expire_at ?? null });
    }
    await this.saveState();
    const found = new Set(online.map((o) => o.name));
    return { online, offline: partners.filter((p) => !found.has(p.name)).map((p) => p.name) };
  }

  /** The address one partner is at now, from presence: only a record of that partner's own key counts. */
  async addressFor(partner) {
    const result = await this.lookupPartners([partner]);
    const entry = result.online.find((o) => o.key === partner.key);
    if (!entry) throw runtimeError("partner_offline", `${partner.name} is not online right now${result.error ? ": " + result.error : ""}`);
    return entry.w;
  }

  /**
   * Where a message for to goes and the key it is sealed to. to is a partner's
   * key or name, reached where presence says, or a write address whose key
   * this runtime knows. The partner chosen stays chosen: a key given is never
   * turned into a name and back.
   */
  async recipient(to) {
    if (typeof to === "string" && ADDRESS.test(to)) {
      const key = this.state.peers[to];
      if (!key) {
        throw runtimeError("unknown_address", `no key known for address ${to}. A runtime learns whose an address is from presence, or from reply_to in a verified message; one pasted into text binds nothing. Send to the partner by name, or answer a message at its reply_to.`);
      }
      return { w: to, key, partner: null };
    }
    const partner = isKey(String(to)) ? this.partnerByKey(to) : this.partnerByName(to);
    if (!partner) throw runtimeError("unknown_partner", isKey(String(to)) ? "key is not in partners" : `unknown partner: ${to}`);
    return { w: await this.addressFor(partner), key: partner.key, partner };
  }

  // -------------------------------------------------------------- send --

  /** One message, signed and sealed to the recipient, written to the outbox before it goes. */
  async send(to, { text = null, data = null, re = null } = {}) {
    if (re !== null && re !== undefined && !HASH.test(String(re))) throw runtimeError("invalid_re", "re is the sha256 of the message this answers: 64 lowercase hex characters, as read shows it");
    const { w, key, partner } = await this.recipient(to);
    // What the inbox asks of writers is read before anything is stored: a
    // requirement this client cannot meet stops here, as a GateStop.
    let advice = await this.client.planFor(w);
    const inbox = await this.ensureInbox();
    // The answer comes to reply_to, and the partner finds the sender there
    // through presence, which lives two minutes: a send refreshes it.
    await this.publishPresence();
    const body = { from: this.keys.hash.slice(0, 8), reply_to: inbox.w };
    if (text !== null && text !== undefined) body.text = String(text);
    if (data !== null && data !== undefined) body.data = data;
    if (re) body.re = re;
    const plaintext = JSON.stringify(body);
    let entry = await this.outboxAdd(w, key, this.keys.seal(key, plaintext), body);
    let answer = await this.deliver(entry, advice);
    if ((answer.status === 404 || answer.status === 410) && partner !== null) {
      // The partner may have renewed its inbox. Presence is asked again, once,
      // for the same partner, and the new address means new bytes, so a new
      // outbox entry.
      const w2 = await this.addressFor(partner);
      advice = await this.client.planFor(w2);
      entry = await this.outboxAdd(w2, partner.key, this.keys.seal(partner.key, plaintext), body, entry.id);
      answer = await this.deliver(entry, advice);
    }
    if (answer.status !== 201) {
      throw runtimeError("send_failed", `send ${entry.status} (http ${answer.status}): ${JSON.stringify(answer.result)}`, { outcome: entry.status, message_id: entry.id, status: answer.status, outbox_error: answer.outboxError });
    }
    const sent = { to: this.nameForKey(entry.to_key) ?? entry.to_key, w: entry.w, message_id: entry.id, seq: answer.result.seq, at: answer.result.at, sha256: answer.result.sha256, expire_at: answer.result.expire_at };
    if (answer.notes?.length) sent.notes = answer.notes;
    if (answer.outboxError) {
      // Delivered: the service said 201. Only the record of it on this machine
      // failed, and the answer has to say both, or a caller sends it again.
      sent.outbox_error = answer.outboxError;
      sent.note = "Delivered: aamio stored it. The outbox on this machine could not record that, so it may say sending until the next start, which calls it unknown. Do not send this message again.";
    }
    return sent;
  }

  /** One durable entry per message, written before the first attempt. Every retry sends the same bytes, so the recipient sees a replay, not a new message. */
  async outboxAdd(w, key, envelope, body, replaces = null) {
    const size = Buffer.byteLength(envelope, "utf8");
    if (size > MESSAGE_MAX_BYTES) throw runtimeError("too_large", `this message is ${size} bytes sealed, and a message is at most ${MESSAGE_MAX_BYTES}, so nothing was stored or sent. Send a URL and a hash instead.`);
    const summary = {};
    for (const field of ["post", "reply_to", "channel"]) if (field in body) summary[field] = body[field];
    const entry = {
      id: "m-" + sha256hex(`${this.keys.public}|${w}|${envelope}`).slice(0, 16),
      w, to_key: key, envelope, summary, shape: messageShape(body, envelope),
      created_at: Math.floor(this.now()), attempts: 0, status: "sending", last_status: null, replaces, tracked: true,
    };
    const earlier = this.outbox[entry.id];
    this.outbox[entry.id] = entry;
    try {
      await this.saveOutbox();
    } catch (error) {
      // Not written, so not sent: the entry goes again, or a restart would
      // find a send in flight that never left.
      if (earlier === undefined) delete this.outbox[entry.id];
      else this.outbox[entry.id] = earlier;
      throw error;
    }
    return entry;
  }

  async post(w, envelope, headers) {
    try {
      return { status: 201, result: await this.client.request("POST", "/" + w, { body: envelope, headers, expect: [201] }) };
    } catch (error) {
      if (error instanceof AamioError) return { status: error.status, result: error.body };
      // No answer at all: the bytes may be on the other side.
      return { status: 0, result: { error: error.message } };
    }
  }

  /** The stored bytes sent once, and what the answer allows this side to claim recorded. */
  async deliver(entry, advice) {
    entry.attempts = (entry.attempts || 0) + 1;
    entry.status = "sending";
    try {
      await this.saveOutbox();
    } catch (error) {
      // Nothing has left this machine, and nothing will.
      entry.status = entry.ever_open ? "unknown" : "stopped";
      throw runtimeError("not_sent", `the outbox could not be written (${error.code || error.message}), so message ${entry.id} was not sent. Free the disk, then send it again.`, { message_id: entry.id, outcome: entry.status });
    }
    const headers = { "Content-Type": "application/json", "X-Key": this.keys.public, "X-Sig": this.keys.sign(threadSigningInput(entry.w, entry.envelope)) };
    let notes = [...(advice.notes || [])];
    let answer;
    try {
      if (advice.bits) headers["X-Work"] = this.client.work(entry.w, this.keys.public, entry.envelope, advice.bits);
      answer = await this.post(entry.w, entry.envelope, headers);
      // A 428 carries the gate. The work it asks is done and the same bytes
      // go once more, never twice: each try costs a place in the rate window.
      const gate = answer.status === 428 && isObject(answer.result) && isObject(answer.result.gate) ? answer.result.gate : null;
      if (gate) {
        this.client.gates.set(entry.w, gate);
        if (Number.isInteger(answer.result.seconds_left)) this.client.gateLeft.set(entry.w, [answer.result.seconds_left, Date.now()]);
        const asked = gatePlan(gate, entry.w, this.host, this.client.secondsLeft(entry.w));
        if (asked.bits && asked.bits !== advice.bits) {
          headers["X-Work"] = this.client.work(entry.w, this.keys.public, entry.envelope, asked.bits);
          notes = [...notes, ...asked.notes.filter((n) => !notes.includes(n))];
          entry.attempts += 1;
          answer = await this.post(entry.w, entry.envelope, headers);
        }
      }
    } catch (error) {
      if (!(error instanceof GateStop)) throw error;
      // Nothing left this machine for this decision, unless an earlier attempt is still open.
      entry.status = entry.ever_open ? "unknown" : "stopped";
      entry.error = error.reason ?? error.message;
      entry.last_at = Math.floor(this.now());
      await this.saveOutbox();
      throw error;
    }
    if (notes.length) entry.gate_notes = notes;
    this.recordAnswer(entry, answer.status, answer.result);
    let outboxError = null;
    try {
      await this.saveOutbox();
    } catch (error) {
      outboxError = `${error.code || error.name}: ${error.message}`;
    }
    return { ...answer, notes, outboxError };
  }

  /** What one answer changes about a message. Certainty only narrows: a delivery settles it, a refusal settles it only when nothing before was left open. */
  recordAnswer(entry, status, result) {
    entry.last_status = status;
    entry.last_at = Math.floor(this.now());
    if (status === 404 || status === 410) this.client.forgetGate(entry.w);
    if (status === 201) {
      entry.status = "delivered";
      entry.seq = isObject(result) ? result.seq ?? null : null;
      return;
    }
    const error = isObject(result) ? result.error : String(result).slice(0, 200);
    if (error) entry.error = error;
    if (status === 0) {
      entry.ever_open = true;
      entry.status = "unknown";
      return;
    }
    if (SEND_NOT_STORED.includes(status)) {
      entry.status = entry.ever_open ? "attempted" : "refused";
      return;
    }
    entry.ever_open = true;
    entry.status = "attempted";
  }

  /** What has no settled outcome on this machine: sending, unknown, attempted, working. */
  outboxPending() {
    return Object.values(this.outbox).filter((e) => isObject(e) && !["delivered", "refused", "stopped"].includes(e.status))
      .map((e) => ({ message_id: e.id, to: this.nameForKey(e.to_key) ?? e.to_key, w: e.w, status: e.status, attempts: e.attempts, last_status: e.last_status ?? null, created_at: e.created_at }));
  }

  // -------------------------------------------------------------- read --

  /** What was said, and separately what can be trusted about it. Nothing a sender writes can set a field of ours. */
  openMessage(message) {
    const raw = message.body;
    if (!message.verified || !message.from) return [{ text: raw }, { signed: false, encrypted: false, format: "unsigned" }];
    if (!isEnvelope(raw)) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [{ text: raw }, { signed: true, encrypted: false, format: "text" }];
      }
      return isObject(parsed) ? [parsed, { signed: true, encrypted: false, format: "json" }] : [{ text: raw }, { signed: true, encrypted: false, format: "json" }];
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(this.keys.open(message.from, raw));
    } catch (error) {
      return [{ text: null }, { signed: true, encrypted: true, format: "unreadable", error: error.name || "Error" }];
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [{ text }, { signed: true, encrypted: true, format: "text" }];
    }
    return isObject(parsed) ? [parsed, { signed: true, encrypted: true, format: "json" }] : [{ text: parsed }, { signed: true, encrypted: true, format: "json" }];
  }

  /** One message checked and decoded here, without lending it the service's authority. */
  readEntry(channel, raw) {
    const message = isObject(raw) ? raw : {};
    const seq = Number.isInteger(message.seq) ? message.seq : 0;
    const at = Number.isInteger(message.at) ? message.at : 0;
    try {
      if (!Number.isInteger(message.seq) || !Number.isInteger(message.at)) throw new Error("invalid message metadata");
      const checked = checkMessage(channel.w, message);
      const sender = checked.verified ? message.from : null;
      const [body, meta] = this.openMessage({ ...message, verified: checked.verified, from: sender });
      const known = this.nameForKey(sender);
      const digest = checked.sha256 ?? null;
      const entry = {
        channel: channel.label, w: channel.w, seq, at, verified: checked.verified, from_key: sender, known_contact: known !== null,
        sender: known ?? (sender ? "unknown key" : "unsigned"), sha256: digest, replay: digest !== null && channel.seen.includes(digest), body, ...meta,
      };
      if (checked.whyNot) entry.unverified_because = checked.whyNot;
      return entry;
    } catch (error) {
      const why = "the message could not be checked here: " + (error.name || "Error");
      return { channel: channel.label, w: channel.w, seq, at, verified: false, from_key: null, known_contact: false, sender: "unsigned", sha256: null, replay: false, body: { text: message.body ?? null }, signed: false, encrypted: false, format: "unreadable", error: error.name || "Error", unverified_because: why };
    }
  }

  /**
   * A scope in an incoming message, taken out before anyone reads it. Node
   * keeps no scopes yet, so a share is never kept here, and the key is never
   * handed on: aamio_scope is replaced, wherever it sits and whatever it holds,
   * by what aamio-python shows in its place, with why it was not kept.
   */
  takeScopeShare(entry) {
    const body = entry.body;
    if (!isObject(body)) return;
    if ("aamio_scope" in body) body.aamio_scope = { kept: false, note: "not kept: a scope is shared in data.aamio_scope" };
    const data = body.data;
    if (!isObject(data) || !("aamio_scope" in data)) return;
    const share = data.aamio_scope;
    if (!isObject(share)) {
      data.aamio_scope = { kept: false, note: "not kept: data.aamio_scope is an object with name, and key or address" };
      return;
    }
    data.aamio_scope = {
      shared_as: typeof share.name === "string" ? share.name : null,
      can_read: share.key !== undefined && share.key !== null,
      kept: false,
      note: "not kept: this Node runtime keeps no scopes yet. Ask the partner to share it again to a home run by aamio-python or aamio-php, which keep it.",
    };
  }

  /** A verified message that names an address binds its signer's key to it, once. A different key later is a conflict, and the binding stays. */
  bindClaimedAddress(channel, entry, field, address, senderKey) {
    if (typeof address !== "string" || !ADDRESS.test(address)) return;
    const bound = this.state.peers[address];
    if (bound === undefined) {
      this.state.peers[address] = senderKey;
      return;
    }
    if (bound === senderKey) return;
    (entry.binding_conflicts ??= []).push({ field, address, claimed_by: senderKey, bound_to: bound });
    this.note(channel.label, "binding_conflict", `message ${entry.seq} names ${address} as ${field}, signed by ${this.nameForKey(senderKey) ?? senderKey}, and that address is already bound to ${this.nameForKey(bound) ?? bound}. The binding is kept.`, channel.w);
  }

  /**
   * One channel read. The cursor and the hashes of what is handed over are saved
   * before the caller sees a message: a crash after that redelivers nothing, and
   * one before it redelivers what the stored hashes then mark as replays.
   */
  async poll(channel, wait = 0, limit = null) {
    if (channel.muted) return [];
    const before = { after: channel.after, created_at: channel.created_at, gone: channel.gone, seen: [...channel.seen], peers: { ...this.state.peers } };
    try {
      return await this.pollOnce(channel, wait, limit, true);
    } catch (error) {
      if (!error?.notSaved) throw error;
      // What this read changed is undone in memory too: the cursor, the hashes
      // and the bindings stay as the file has them, and the messages wait at
      // the service for the next read, which hands them over.
      Object.assign(channel, { after: before.after, created_at: before.created_at, gone: before.gone, seen: before.seen });
      this.state.peers = before.peers;
      this.note(channel.label, "not_saved", `what this read found here could not be written down (${error.cause?.code || error.cause?.message}), so nothing from this channel was handed over. It is still there for the next read, and nothing was skipped.`, channel.w);
      return [];
    }
  }

  async saveRead() {
    try {
      await this.saveState();
    } catch (cause) {
      throw Object.assign(new Error("the read could not be saved"), { notSaved: true, cause });
    }
  }

  async pollOnce(channel, wait, limit, again) {
    let path = "/" + channel.w;
    if (channel.after > 0 || wait > 0) path += "/after/" + channel.after;
    if (wait > 0) path += "/wait/" + Math.min(25, wait);
    const headers = { "X-Read": channel.read_key };
    if (limit !== null) headers["X-Limit"] = String(limit);
    let data;
    try {
      data = await this.client.request("GET", path, { headers, expect: [200] });
    } catch (error) {
      if (error instanceof AamioError && error.status === 410) {
        this.note(channel.label, "expired", "the thread at this address has expired, so nothing more will arrive here", channel.w);
        return [];
      }
      this.note(channel.label, "unread", `the service answered ${error.status ?? 0}, so this channel was not read and there may be messages waiting`, channel.w);
      return [];
    }
    if (!isObject(data) || !Array.isArray(data.messages)) {
      this.note(channel.label, "unread", "the service returned a malformed read answer; this channel was not read", channel.w);
      return [];
    }
    if (data.exists === false) {
      if (!channel.gone) this.note(channel.label, "gone", "there is no thread at this address any more: it expired and was swept, or the service restarted and it went with it" + (channel.label === "inbox" ? ", so a new inbox is opened for the partners" : ""), channel.w);
      channel.gone = true;
      // The cursor belonged to that thread. The hashes are the reader's and stay.
      channel.after = 0;
      channel.created_at = null;
      await this.saveRead();
      return [];
    }
    channel.gone = false;
    const created = data.created_at ?? null;
    if (again && channel.created_at !== null && created !== null && created !== channel.created_at && !data.reset) {
      this.note(channel.label, "restarted", `the thread at this address is a new one, opened at ${created} where this channel knew one opened at ${channel.created_at}, so it is read again from the start`, channel.w);
      channel.after = 0;
      channel.created_at = null;
      return this.pollOnce(channel, 0, limit, false);
    }
    if (data.reset) this.note(channel.label, "restarted", (isObject(data.reset) && data.reset.what) || "the service read this thread from the start", channel.w);
    channel.created_at = created;

    const entries = [];
    const keptOut = [];
    let lastSeq = null;
    for (const raw of data.messages) {
      if (limit !== null && entries.length >= limit) break;
      const entry = this.readEntry(channel, raw);
      lastSeq = lastSeq === null ? entry.seq : Math.max(lastSeq, entry.seq);
      const allow = channel.allow || [];
      const excluded = allow.length > 0 && !(entry.verified && (allow.includes("*") || allow.includes(entry.from_key)));
      if (excluded) {
        keptOut.push(entry.seq);
        continue;
      }
      if (entry.sha256 !== null && !channel.seen.includes(entry.sha256)) channel.seen.push(entry.sha256);
      this.takeScopeShare(entry);
      if (isObject(entry.body) && entry.verified && entry.from_key) {
        for (const field of ["reply_to", "channel"]) this.bindClaimedAddress(channel, entry, field, entry.body[field], entry.from_key);
      }
      entries.push(entry);
    }
    if (keptOut.length) {
      const openedFor = (channel.allow || []).includes("*") ? "any key, signed only" : `${channel.allow.length} named key(s)`;
      this.note(channel.label, "kept_out", `${keptOut.length} message(s) (seq ${keptOut.join(", ")}): this channel was opened for ${openedFor}, and these did not satisfy that list as checked here. They are not handed over.`, channel.w);
    }
    const stoppedEarly = limit !== null && entries.length >= limit && data.messages.length > entries.length + keptOut.length;
    if (stoppedEarly && lastSeq !== null) channel.after = lastSeq;
    else if (Number.isInteger(data.next)) channel.after = data.next;
    else if (lastSeq !== null) channel.after = Math.max(channel.after, lastSeq);
    await this.saveRead();
    return entries;
  }

  /** Messages on every channel still read, the inbox first. The inbox is opened and presence published as the read starts. */
  async read({ wait = 0, limit = 50 } = {}) {
    await this.ensureInbox();
    await this.publishPresence();
    const now = this.now();
    const channels = this.state.channels.filter((c) => isObject(c) && !c.muted && Number(c.expire_at) > now)
      .sort((a, b) => (a.label === "inbox" ? -1 : b.label === "inbox" ? 1 : 0));
    const messages = [];
    // Every channel without waiting first: a message on an older inbox that
    // is still read is handed over at once, not after a wait on the new one.
    for (const channel of channels) {
      if (messages.length >= limit) break;
      messages.push(...(await this.poll(channel, 0, limit - messages.length)));
    }
    const inbox = this.channel("inbox");
    if (!messages.length && wait > 0 && inbox && !inbox.muted) messages.push(...(await this.poll(inbox, wait, limit)));
    return messages;
  }
}
