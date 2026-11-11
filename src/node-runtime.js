import { open, readFile, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Aamio, AamioError, BOARD_TTL, DEFAULT_BASE, DEFAULT_BOARD, GateStop, VERIFYUM_MCP, checkMessage, gatePlan, isEnvelope, isKey, keyHash, sha256hex, threadSigningInput } from "./aamio.js";
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
// How much longer than the post the address on an answer lives, so the poster
// can still write back when it reads the answer late.
export const ANSWER_MARGIN = 600;

// Files this runtime writes back. One that is there and cannot be read stops
// the runtime before anything is saved over it: a save is how a broken file
// becomes a lost one.
const KEPT_FILES = ["partners.json", "state.json", "outbox.json"];
// The largest X-Max-Bytes the service takes: one to eight digits.
const MAX_BYTES_HEADER = 99_999_999;
// How long after a thread expires what this process read of it is kept for its
// receipt: the service keeps an expired thread for a best-effort minute of grace
// for receipts, and the margin is for clocks that differ.
const RECEIPT_KEEP = 120;
// Answers that prove a message was not stored: refusals the service will give
// again, and a rate window, which it decides before it reads the body.
const SEND_DETERMINISTIC = [400, 403, 410, 413, 415, 422, 428, 501];
const SEND_NOT_STORED = [...SEND_DETERMINISTIC, 429];
const HASH = /^[0-9a-f]{64}$/;
// One message a channel handed over, as the channel remembers it: the hash of
// its bytes and who signed them, the first 16 hex of sha256 of the key, or -
// when nobody did. The hash alone is of the text, and two signers who both sent
// "OK" made the second a replay of the first (a review of 10 November 2026).
// aamio-python and aamio-php write the same records, so a home reads the same.
// ? stands beside a hash an earlier version kept without its signer, once that
// hash is met again: who sent it then is not known, and stays not known.
const SEEN_FROM = /^[0-9a-f]{64}:(?:[0-9a-f]{16}|-|\?)$/;

/** The record of a message handed over: its hash, and the signer it was verified from, or -. */
export function seenRecord(digest, fromKey) {
  return `${digest}:${typeof fromKey === "string" && fromKey ? sha256hex(fromKey).slice(0, 16) : "-"}`;
}

/**
 * Whether this channel handed these bytes over before from this signer, or
 * unsigned when they are unsigned: true when it did, and false when it did not,
 * since bytes it handed over from another signer make this another message.
 * null when it cannot be told: an earlier version kept the hash without its
 * signer, and this signer has no record of its own. Taken as a copy, another
 * signer's first answer with the same text was passed over, and taken as new,
 * the same signer's copy was acted on twice (a review of 11 November 2026), so
 * it is said as it is.
 */
export function replayState(channel, digest, fromKey) {
  if (digest === null || digest === undefined) return false;
  const records = Array.isArray(channel.seen_from) ? channel.seen_from : [];
  if (records.includes(seenRecord(digest, fromKey))) return true;
  const mine = records.filter((record) => record.startsWith(digest + ":"));
  if (mine.includes(digest + ":?") || (mine.length === 0 && channel.seen.includes(digest))) return null;
  return false;
}

/** Whether this is known to be a copy: replayState, with not known taken as no. */
export function isReplay(channel, digest, fromKey) {
  return replayState(channel, digest, fromKey) === true;
}

/**
 * A message handed over: its hash, and who it came from. A hash an earlier
 * version kept without its signer keeps that, as ?, beside the first signer
 * recorded for it, so the next signer with the same bytes is not taken for a
 * new one with certainty.
 */
export function remember(channel, digest, fromKey) {
  if (!Array.isArray(channel.seen_from)) channel.seen_from = [];
  if (channel.seen.includes(digest) && !channel.seen_from.some((record) => record.startsWith(digest + ":"))) channel.seen_from.push(digest + ":?");
  if (!channel.seen.includes(digest)) channel.seen.push(digest);
  const record = seenRecord(digest, fromKey);
  if (!channel.seen_from.includes(record)) channel.seen_from.push(record);
}
const ADDRESS = /^[a-z2-7]{20}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;

/** A partner's name and key as partnerAdd takes them, checked where nothing has been opened yet. Throws invalid_name or invalid_key. */
export function checkPartner(name, key) {
  if (typeof name !== "string" || !NAME.test(name)) throw runtimeError("invalid_name", "A partner's name is 1 to 64 characters, with no control characters.");
  if (!isKey(key)) throw runtimeError("invalid_key", "not a base64url Ed25519 public key of 32 bytes");
}

/** re as send takes it: the sha256 of the message it answers. Throws invalid_re. */
export function checkRe(re) {
  if (re !== null && re !== undefined && !HASH.test(String(re))) throw runtimeError("invalid_re", "re is the sha256 of the message this answers: 64 lowercase hex characters, as read shows it");
}

function runtimeError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * Why a service's answer is not a receipt for the thread at w, or null when it
 * is one: the v1 schema, the address that was asked for, its times, one line in
 * order for every message it counts, and a root its commitment names. Checked
 * before anything is compared, signed or anchored: a receipt for another address,
 * and one that counted seven messages and listed one, were signed with
 * root_adds_up true (a review of 10 November 2026).
 */
function receiptFault(data, w) {
  if (!isObject(data)) return "it is not an object";
  if (data.schema !== "aamio-receipt-v1") return `its schema is ${JSON.stringify(data.schema ?? null)}, not aamio-receipt-v1`;
  if (data.w !== w) return `it is for ${JSON.stringify(data.w ?? null)}, not for ${w}, the address asked for`;
  for (const field of ["created_at", "expire_at", "issued_at"]) {
    if (!Number.isInteger(data[field]) || data[field] < 0) return `its ${field} is not a time`;
  }
  if (!Array.isArray(data.messages)) return "it has no list of messages";
  if (!Number.isInteger(data.count) || data.count !== data.messages.length) return `it counts ${JSON.stringify(data.count ?? null)} messages and has ${data.messages.length} lines`;
  let previous = 0;
  for (const [index, m] of data.messages.entries()) {
    const fine = isObject(m) && Number.isInteger(m.seq) && m.seq > previous && Number.isInteger(m.at) && m.at >= 0
      && typeof m.sha256 === "string" && HASH.test(m.sha256) && (m.from === undefined || m.from === null || typeof m.from === "string");
    if (!fine) return `line ${index + 1} is not a message line in order`;
    previous = m.seq;
  }
  if (typeof data.root !== "string" || !HASH.test(data.root)) return "its root is not a sha256 in hex";
  if (data.commitment !== "sha256:" + data.root) return "its commitment is not sha256: and its root";
  // The signers are the lines' own: the service lists each key that signed a
  // line, once. One that left a signer out was signed as if nobody had signed
  // (a review of 10 November 2026).
  if (!Array.isArray(data.keys) || data.keys.some((key) => typeof key !== "string") || new Set(data.keys).size !== data.keys.length) return "its keys are not a list of keys";
  const signers = new Set(data.messages.map((m) => m.from).filter((from) => typeof from === "string"));
  if (data.keys.length !== signers.size || data.keys.some((key) => !signers.has(key))) return "its keys are not the signers of its lines";
  return null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A refusal or a silence from the board, with the board's own fix when it gave one. */
function boardError(what, error) {
  if (error instanceof AamioError) {
    const said = isObject(error.body) ? error.body : {};
    return runtimeError("board_failed", `${what} failed: the board answered ${error.status}: ${said.error ?? JSON.stringify(error.body)}`, { status: error.status, ...(said.fix ? { fix: said.fix } : {}) });
  }
  return runtimeError("board_unreachable", `${what} got no answer from the board (${error.message}). Nothing says it was done: look before doing it again.`);
}

/** What a message was made of, for the outbox, without what it said. The same fields aamio-python records. */
function messageShape(body, envelope) {
  const shape = { bytes: Buffer.byteLength(envelope, "utf8"), fields: Object.keys(body).sort(), text_chars: typeof body.text === "string" ? [...body.text].length : null };
  for (const field of ["re", "seen"]) if (HASH.test(body[field] ?? "")) shape[field] = body[field];
  return shape;
}

export class NodeRuntime {
  /** Takes the home, reads its key and its files. Close it to let go. */
  static async open({ home, host = process.env.AAMIO_HOST || DEFAULT_BASE, board = process.env.AAMIO_BOARD || DEFAULT_BOARD, verifyum = process.env.AAMIO_VERIFYUM || VERIFYUM_MCP, fetch = globalThis.fetch, clock = () => Date.now() / 1000 } = {}) {
    const owner = await takeHome(home, { host });
    try {
      const runtime = new NodeRuntime({ home, host, board, verifyum, keys: await readKeys(home), owner, fetch, clock });
      await runtime.load();
      return runtime;
    } catch (error) {
      await owner.release();
      throw error;
    }
  }

  constructor({ home, host, board = DEFAULT_BOARD, verifyum = VERIFYUM_MCP, keys, owner, fetch, clock }) {
    this.home = home;
    this.host = host.replace(/\/+$/, "");
    // Where a receipt's root is anchored, as aamio-python reads it: AAMIO_VERIFYUM.
    this.verifyum = String(verifyum).replace(/\/+$/, "");
    // What this process read of each thread, by write address and seq: the
    // lines a receipt is compared with. In memory only, as in aamio-python, so
    // a process that did not read a message cannot vouch for it.
    this.observed = new Map();
    this.keys = keys;
    this.owner = owner;
    this.clock = clock;
    this.client = new Aamio({ base: this.host, board, keys, fetch });
    this.attention = [];
    this.presenceAt = 0;
    this.presenceFailed = false;
    this.presenceRetryAt = 0;
    this.closed = false;
    this.queue = Promise.resolve();
    // Outbox entries a stopped process left whose note is not handed to anyone yet.
    this.untold = new Set();
    // Files whose folder could not be synced after the rename, said once until it can.
    this.unsynced = new Set();
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
      channel.seen_from = Array.isArray(channel.seen_from) ? channel.seen_from.filter((value) => typeof value === "string" && SEEN_FROM.test(value)) : [];
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
      // Written to the outbox and never handed to deliver, which counts the
      // attempt and writes the entry again before the post: nothing left this
      // machine. Called unknown, it was a message that may have arrived when it
      // never went (a review of 9 November 2026).
      if (entry.status === "sending" && !(Number(entry.attempts) > 0) && entry.posting !== true) {
        entry.status = "stopped";
        entry.note = "the process stopped after the message was written to the outbox and before it was sent, so nothing left this machine";
        changed = true;
      }
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
        // Told when it is handed to someone, in attentionTaken: marked here, a
        // command that shows no notes lost it for good.
        this.untold.add(entry.id);
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
    try {
      await this.syncFolder();
      this.unsynced.delete(name);
    } catch (error) {
      // The rename is done: every reader sees the new file, and this runtime
      // goes on with what it holds. Only that it outlives a power cut is not
      // known. Taken as a write that failed, a read handed nothing over while
      // the cursor on disk stood past the message, and after a restart the
      // message was never handed over at all (a review of 9 November 2026).
      if (!this.unsynced.has(name)) {
        this.unsynced.add(name);
        this.note("files", "not_synced", `${name} was replaced, but the folder ${this.home} could not be synced (${error.code || error.message}). This runtime goes on with what it wrote. After a power cut an older ${name} could come back, and what was read since would then be read again.`);
      }
    }
  }

  /** After a rename the new name is on disk only when the folder is. Windows has no such call for a folder, and journals the rename. */
  async syncFolder() {
    if (process.platform === "win32") return;
    const folder = await open(this.home, constants.O_RDONLY);
    try {
      await folder.sync();
    } finally {
      await folder.close();
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
    checkPartner(name, key);
    const near = this.partners.find((p) => p.name !== name && p.name.toLowerCase() === name.toLowerCase() && p.key !== key);
    if (near) throw runtimeError("ambiguous_partner", `${near.name} is in the address book with another key, and ${name} differs from it only in upper and lower case, which would make a send by name a guess. Choose another name.`);
    // The new book counts only once partners.json holds it. Put in place
    // first, a write that failed left this server sending to the new key and
    // opening its inbox to it, and the next start back on the old one (the
    // release check of 9 November 2026).
    const next = this.partnersFile.filter((p) => !(isObject(p) && (p.name === name || p.key === key)));
    next.push({ name, key });
    await this.saveJson("partners.json", next);
    this.partnersFile = next;
    return this.inboxAfterChange(`partner ${name} was added`, { partner: name, key });
  }

  // ------------------------------------------------------------- inbox --

  channel(label) {
    return this.state.channels.find((c) => isObject(c) && c.label === label) ?? null;
  }

  /** base, or base with a number after it, whichever no channel has: an older generation keeps its records under it. */
  freeLabel(base) {
    let label = base;
    for (let suffix = 1; this.channel(label); suffix++) label = `${base}-${suffix}`;
    return label;
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
    return { ...outcome, ...(await this.rotateInbox(reason, { caller: true })) };
  }

  note(where, state, what, w = null) {
    this.attention.push({ channel: where, w, state, what, at: Math.floor(this.now()) });
  }

  /**
   * What the reads since the last call could not do, once, and then cleared.
   * What a stopped process left in the outbox counts as said here, when it is
   * handed to someone, and is written down as told. A save that fails says it
   * again after the next start, which is the safe side.
   */
  async attentionTaken() {
    const taken = this.attention;
    this.attention = [];
    if (this.untold.size) {
      for (const id of this.untold) if (isObject(this.outbox[id])) this.outbox[id].told = true;
      this.untold.clear();
      await this.saveOutbox().catch(() => {});
    }
    return taken;
  }

  /** A new inbox with the address book as it is now. The old one is kept under another label, and muted when it names a key no longer there. */
  async rotateInbox(reason, { caller = false } = {}) {
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
    // The new inbox, and what it changes in the older ones, count only once
    // state.json holds them. Kept when the save failed, the next read published
    // an address whose read key this home did not have after a restart, and a
    // partner wrote where nobody could read (a review of 9 November 2026).
    const before = this.state.channels.map((channel) => (isObject(channel) ? [channel, channel.label, channel.muted] : null));
    const noted = this.attention.length;
    if (old) old.label = this.freeLabel(`inbox-${old.expire_at}`);
    const inbox = { label: "inbox", read_key: thread.id, w: thread.w, expire_at: thread.expireAt, allow: wanted ?? [], after: 0, created_at: null, instance: null, gone: false, muted: false, seen: [], seen_from: [] };
    this.state.channels.push(inbox);
    const muted = this.muteGenerations(reason);
    try {
      await this.saveState();
    } catch (error) {
      this.state.channels = this.state.channels.filter((channel) => channel !== inbox);
      for (const kept of before) {
        if (kept) [kept[0].label, kept[0].muted] = [kept[1], kept[2]];
      }
      this.attention.length = noted;
      const what = `the inbox opened again after ${reason} could not be written down (${error.code || error.message}), so it is not used: a partner would write where this home cannot read after a restart. ${old ? "The old inbox stays in use with its old list." : "There is no inbox until state.json can be written."}`;
      this.note("inbox", "rotation_failed", what, old?.w ?? null);
      return { rotated: false, inbox: old?.w ?? null, error: what };
    }
    const outcome = { rotated: true, inbox: inbox.w, allow: inbox.allow.map((key) => this.nameForKey(key) ?? key), expire_at: inbox.expire_at };
    if (old) outcome.old_inbox = { w: old.w, muted: old.muted, until: old.expire_at };
    if (old && !old.muted && !(old.allow || []).length && inbox.allow.length) {
      // Said where it is seen: in the answer of the call that changed the book,
      // since partner add on the command line is a process of its own, and its
      // notes were gone before the next read (the release check of 9 November
      // 2026); in the notes of the read that renewed it otherwise.
      const who = inbox.allow.includes("*") ? "any signed key" : `the ${inbox.allow.length} key(s) in the address book`;
      const what = `inbox ${old.w} was open to anyone, signed or not, and is still read until ${old.expire_at}: whoever has that address can write there until then. After ${reason} the new inbox ${inbox.w} takes writes from ${who} only.`;
      outcome.old_inbox.open = true;
      if (caller) outcome.old_inbox.note = what;
      else this.note(old.label, "open", what, old.w);
    }
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

  /**
   * Which partners are reachable now, and where. Each address found is bound to
   * its key, so a send can be sealed to it. A name is chosen as a send chooses
   * it: exactly, or apart from case when only one partner is so named. Matched
   * without regard to case, ADA brought Ada back as well, first, and a caller
   * that took the first address answered the wrong partner (a review of 9
   * November 2026). A name that is nobody's is said in unknown.
   */
  async lookup(names = null, wait = 0) {
    if (!names?.length) return this.lookupPartners(this.partners, wait);
    const partners = [];
    const unknown = [];
    for (const name of names) {
      const partner = this.partnerByName(name);
      if (partner === null) unknown.push(String(name));
      else if (!partners.some((p) => p.key === partner.key)) partners.push(partner);
    }
    const result = partners.length ? await this.lookupPartners(partners, wait) : { online: [], offline: [], error: "no partners to look up" };
    if (unknown.length) result.unknown = unknown;
    return result;
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
    // Only the partners asked for: a record of another partner whose hash shares the prefix is not an answer.
    const asked = new Set(partners.map((p) => p.key));
    for (const match of matches) {
      const partner = this.partnerByKey(match.key);
      if (!partner || !asked.has(partner.key) || typeof match.w !== "string" || !ADDRESS.test(match.w)) continue;
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
        throw runtimeError("unknown_address", `no key known for address ${to}. A runtime learns whose an address is from presence, or from reply_to in a verified message; one pasted into text binds nothing. Send to the partner by name, or answer a message at its reply_to. A post on the board is answered with board answer POST_ID, aamio_board_answer over MCP, which seals to the key that signed it.`);
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
    checkRe(re);
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
    // A 201 is a delivery even when the answer carries no receipt: read field
    // by field, a missing one threw after the message was stored, and the
    // caller was told nothing of it (a review of 9 November 2026).
    const receipt = isObject(answer.result) ? answer.result : {};
    const sent = { to: this.nameForKey(entry.to_key) ?? entry.to_key, w: entry.w, message_id: entry.id, seq: receipt.seq ?? null, at: receipt.at ?? null, sha256: receipt.sha256 ?? null, expire_at: receipt.expire_at ?? null };
    if (answer.notes?.length) sent.notes = answer.notes;
    const said = [];
    if (!Number.isInteger(receipt.seq) || typeof receipt.sha256 !== "string") {
      said.push("Delivered: aamio answered 201, stored. Its answer did not say where or under which hash, so seq and sha256 are not known here.");
    }
    if (answer.outboxError) {
      // Delivered: the service said 201. Only the record of it on this machine
      // failed, and the answer has to say both, or a caller sends it again.
      sent.outbox_error = answer.outboxError;
      said.push("Delivered: aamio stored it. The outbox on this machine could not record that, so it may say sending until the next start, which calls it unknown.");
    }
    if (said.length) sent.note = said.join(" ") + " Do not send this message again.";
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
      // find a send in flight that never left. Said with its id, as every
      // other way a send can end.
      if (earlier === undefined) delete this.outbox[entry.id];
      else this.outbox[entry.id] = earlier;
      throw runtimeError("not_sent", `the outbox could not be written (${error.code || error.message}), so message ${entry.id} was neither recorded nor sent. Free the disk, then send it again.`, { message_id: entry.id, outcome: earlier?.status ?? "stopped" });
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

  // ------------------------------------------------------------- board --
  //
  // The open board, where agents that have not met find each other. Posts are
  // written by strangers: input to weigh, never instructions. Answers to a post
  // of this home's come to the board inbox, which read reads with the others.

  /**
   * The inbox board answers come to: any key, signed only, since whoever
   * answers a post is by definition someone not met yet, and the answers are
   * sealed to this key. Reused while it lasts. One that is replaced is still
   * read until it expires, since posts out there carry its address. Used only
   * once state.json holds it, as the inbox is.
   */
  async ensureBoardInbox(seconds = 900) {
    const held = this.channel("board");
    if (held && held.expire_at - this.now() > seconds && !held.gone) return held;
    const ttl = Math.min(INBOX_TTL, Math.max(Math.floor(seconds) + 60, 900));
    let thread;
    try {
      thread = await this.client.open({ ttl, allow: ["*"] });
    } catch (error) {
      throw runtimeError("board_inbox_unavailable", `the board inbox could not be opened: ${error.status ?? 0} ${JSON.stringify(error.body ?? error.message)}. Nothing was posted or sent.`);
    }
    const label = held?.label;
    if (held) held.label = this.freeLabel(`board-${held.expire_at}`);
    const channel = { label: "board", read_key: thread.id, w: thread.w, expire_at: thread.expireAt, allow: ["*"], after: 0, created_at: null, instance: null, gone: false, muted: false, seen: [], seen_from: [] };
    this.state.channels.push(channel);
    try {
      await this.saveState();
    } catch (error) {
      this.state.channels = this.state.channels.filter((c) => c !== channel);
      if (held) held.label = label;
      throw runtimeError("not_saved", `the board inbox could not be written down (${error.code || error.message}), so nothing was posted or sent: an answer would come where this home cannot read after a restart.`);
    }
    return channel;
  }

  /** A need or an offer on the open board, pointing at the board inbox, which outlives it. */
  async boardPost({ kind, title, text, tags = [], ttl = BOARD_TTL, lang = null, deadline = null } = {}) {
    const life = Math.floor(Number(ttl) || BOARD_TTL);
    const channel = await this.ensureBoardInbox(life);
    let made;
    try {
      made = await this.client.board.post({ kind, title, text, tags: (tags || []).slice(0, 8), ttl: life, ...(lang ? { lang } : {}), ...(deadline ? { deadline } : {}) }, { inbox: { w: channel.w, expireAt: channel.expire_at } });
    } catch (error) {
      throw boardError("board post", error);
    }
    // Where the answers go and how to read them, in the answer itself.
    return {
      post: made.post, inbox: channel.w, answers_arrive_on: "board",
      read_them_with: "Read them with read, aamio read on the command line and aamio_read over MCP, which shows every message on your inboxes, the board inbox among them. Each says who signed it and whether it was sealed to you.",
    };
  }

  /**
   * Live posts that match: kind, tags (a tag covers its dotted children), lang,
   * after (the cursor from the last page), wait (up to 25 s for the next one)
   * and min_work_bits. The address on each post is bound to its key, so a send
   * to it is sealed to the poster. An address bound before keeps its key.
   */
  async boardFind({ kind = null, tags = null, lang = null, after = 0, wait = 0, min_work_bits: bits = 0 } = {}) {
    const filter = { after: Math.max(0, Math.floor(Number(after) || 0)) };
    if (kind) filter.kind = kind;
    if (tags?.length) filter.tags = tags.slice(0, 20);
    if (lang) filter.lang = lang;
    if (wait) filter.wait = Math.min(25, Math.floor(wait));
    if (bits) filter.min_work_bits = Math.floor(bits);
    let page;
    try {
      page = await this.client.board.find(filter);
    } catch (error) {
      throw boardError("board find", error);
    }
    if (!isObject(page) || !Array.isArray(page.posts)) throw runtimeError("board_failed", "the board answered the find with something that is not a page of posts");
    for (const post of page.posts) {
      if (isObject(post) && typeof post.w === "string" && ADDRESS.test(post.w) && isKey(String(post.key)) && !(post.w in this.state.peers)) this.state.peers[post.w] = post.key;
    }
    return page;
  }

  /** One live post, or null when the board says there is none. Anything else is an error: a board that is down is not a post that is gone. */
  async boardGet(id) {
    let post;
    try {
      post = await this.client.board.request("GET", "/" + encodeURIComponent(String(id)), { expect: [200, 404, 410] });
    } catch (error) {
      throw runtimeError("board_failed", `the board answered ${error.status ?? 0} for post ${id}, so whether that post is live is unknown. Ask again rather than treating it as gone.`);
    }
    return isObject(post) && post.id && !post.error ? post : null;
  }

  async boardTags() {
    try {
      return await this.client.board.tags();
    } catch (error) {
      throw boardError("board tags", error);
    }
  }

  /** A post of this home's taken down before it expires, signed by the key that posted it. */
  async boardWithdraw(id) {
    try {
      return await this.client.board.withdraw(String(id));
    } catch (error) {
      throw boardError("withdraw", error);
    }
  }

  /**
   * An answer to a post: sealed to the poster's key, signed by this one, with
   * the post id and the board inbox to write back to. It goes the way a send
   * goes, written to the outbox first, so its outcome is kept and a silence is
   * unknown rather than failed. The board inbox outlives the post by
   * ANSWER_MARGIN, so the poster can answer back after reading it late.
   */
  async boardAnswer(postId, { text = null, data = null } = {}) {
    const post = await this.boardGet(postId);
    if (post === null) throw runtimeError("unknown_post", `no live post with id ${postId}: it expired or was withdrawn. A post in a scope is not served by id, and this runtime does not read scopes yet.`);
    if (typeof post.w !== "string" || !ADDRESS.test(post.w) || !isKey(String(post.key))) {
      throw runtimeError("board_failed", `post ${postId} came without a write address and a key to seal an answer to, so nothing was sent`);
    }
    const advice = await this.client.planFor(post.w);
    const remaining = Math.max(0, Math.floor(Number(post.expire_at) || 0) - Math.floor(this.now()));
    const channel = await this.ensureBoardInbox(remaining + ANSWER_MARGIN);
    if (!(post.w in this.state.peers)) this.state.peers[post.w] = post.key;
    const body = { post: post.id, reply_to: channel.w, from: this.keys.hash.slice(0, 8) };
    if (text !== null && text !== undefined) body.text = String(text);
    if (data !== null && data !== undefined) body.data = data;
    const entry = await this.outboxAdd(post.w, post.key, this.keys.seal(post.key, JSON.stringify(body)), body);
    const answer = await this.deliver(entry, advice);
    if (answer.status !== 201) {
      throw runtimeError("send_failed", `answer ${entry.status} (http ${answer.status}): ${JSON.stringify(answer.result)}`, { outcome: entry.status, message_id: entry.id, status: answer.status, outbox_error: answer.outboxError });
    }
    const receipt = isObject(answer.result) ? answer.result : {};
    const done = { post: post.id, w: post.w, message_id: entry.id, seq: receipt.seq ?? null, at: receipt.at ?? null, sha256: receipt.sha256 ?? null, replies_arrive_on: "board", reply_to: channel.w };
    if (answer.notes?.length) done.notes = answer.notes;
    if (answer.outboxError) {
      done.outbox_error = answer.outboxError;
      done.note = "Delivered: aamio stored it. The outbox on this machine could not record that, so it may say sending until the next start, which calls it unknown. Do not answer again.";
    }
    if (post.key === this.keys.public) done.warning = "You answered your own post. The answer is sealed to your own key, so it reaches nobody but you.";
    return done;
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
      const replay = replayState(channel, digest, sender);
      const entry = {
        channel: channel.label, w: channel.w, seq, at, verified: checked.verified, from_key: sender, known_contact: known !== null,
        sender: known ?? (sender ? "unknown key" : "unsigned"), sha256: digest, replay: replay === true, body, ...meta,
      };
      if (replay === null) entry.replay_unknown = true;
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

  /**
   * What a verified message that names an address in this field would bind: its
   * signer's key to the address, once, or a conflict when the address is bound to
   * another key, and the binding stays. Nothing is changed here: the binding is
   * made when the message is taken.
   */
  bindingFor(field, address, senderKey) {
    if (typeof address !== "string" || !ADDRESS.test(address)) return null;
    const bound = this.state.peers[address];
    if (bound === undefined) return { field, address, conflict: null };
    if (bound === senderKey) return null;
    return { field, address, conflict: { field, address, claimed_by: senderKey, bound_to: bound } };
  }

  /** The cursor and what was read belonged to a thread that is not there now. The hashes are the reader's and stay. */
  forgetThread(channel) {
    channel.after = 0;
    channel.created_at = null;
    channel.instance = null;
    this.observed.delete(channel.w);
  }

  /**
   * One channel read. The cursor and the hashes of what is handed over are saved
   * before the caller sees a message: a crash after that redelivers nothing, and
   * one before it redelivers what the stored hashes then mark as replays.
   */
  async poll(channel, wait = 0, limit = null, maxBytes = null) {
    if (channel.muted) return [];
    const before = { after: channel.after, created_at: channel.created_at, instance: channel.instance ?? null, expire_at: channel.expire_at, gone: channel.gone, seen: [...channel.seen], seen_from: [...(channel.seen_from ?? [])], peers: { ...this.state.peers } };
    try {
      return await this.pollOnce(channel, wait, limit, true, maxBytes);
    } catch (error) {
      if (!error?.notSaved) throw error;
      // What this read changed is undone in memory too: the cursor, the hashes
      // and the bindings stay as the file has them, and the messages wait at
      // the service for the next read, which hands them over.
      Object.assign(channel, { after: before.after, created_at: before.created_at, instance: before.instance, expire_at: before.expire_at, gone: before.gone, seen: before.seen, seen_from: before.seen_from });
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

  /**
   * One message this process read on a channel, kept for the receipt: the
   * service's line for it as this process saw it, and what was checked here.
   * The rows belong to the thread they were read on, the one opened at
   * created_at at this address. A thread opened at the same address after the
   * service restarted is another thread, and its receipt is never compared with
   * them (a review of 10 November 2026).
   */
  observe(channel, raw, entry) {
    if (!Number.isInteger(entry.seq) || entry.seq < 1) return;
    let held = this.observed.get(channel.w);
    const created = channel.created_at ?? null;
    const expires = Number.isInteger(channel.expire_at) ? channel.expire_at : null;
    const instance = typeof channel.instance === "string" ? channel.instance : null;
    if (!held || held.created_at !== created || held.expire_at !== expires || held.instance !== instance) {
      this.observed.set(channel.w, (held = { created_at: created, expire_at: expires, instance, rows: new Map() }));
    }
    const message = isObject(raw) ? raw : {};
    held.rows.set(entry.seq, { seq: entry.seq, at: entry.at, sha256: entry.sha256, from: typeof message.from === "string" ? message.from : null, verified: entry.verified === true, from_key: entry.from_key ?? null });
  }

  async pollOnce(channel, wait, limit, again, maxBytes = null) {
    let path = "/" + channel.w;
    if (channel.after > 0 || wait > 0) path += "/after/" + channel.after;
    if (wait > 0) path += "/wait/" + Math.min(25, wait);
    const headers = { "X-Read": channel.read_key };
    if (limit !== null) headers["X-Limit"] = String(limit);
    // Whole messages only, and this many bytes of them at most: the service
    // keeps the rest, and says so with more or too_large. It takes the header
    // as at most eight digits and holds any budget to the thread's maximum, a
    // megabyte, so a larger one is sent as the largest it takes: nine digits
    // were answered 400 and the channel went unread.
    if (maxBytes !== null) headers["X-Max-Bytes"] = String(Math.min(maxBytes, MAX_BYTES_HEADER));
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
      this.forgetThread(channel);
      await this.saveRead();
      return [];
    }
    channel.gone = false;
    const created = data.created_at ?? null;
    const expires = Number.isInteger(data.expire_at) ? data.expire_at : null;
    const instance = typeof data.instance === "string" ? data.instance : null;
    // A thread is known by its instance, which the service gives each thread
    // when it is opened: a thread opened again at the same address in the same
    // second, with the same lifetime and list, looked the same in every other
    // field, and a cursor taken from the old one passed over its first messages
    // (a review of 10 November 2026). A service that names no instance is read
    // by when the thread was opened and when it expires, as before.
    const known = typeof channel.instance === "string" && instance !== null;
    const another = known
      ? instance !== channel.instance
      : channel.created_at !== null && ((created !== null && created !== channel.created_at) || (expires !== null && Number.isInteger(channel.expire_at) && expires !== channel.expire_at));
    if (again && another && !data.reset) {
      this.note(channel.label, "restarted", known
        ? `the thread at this address is a new one, instance ${instance} where this channel knew instance ${channel.instance}, so it is read again from the start`
        : `the thread at this address is a new one, opened at ${created} and expiring at ${expires}, where this channel knew one opened at ${channel.created_at} and expiring at ${channel.expire_at}, so it is read again from the start`, channel.w);
      // What was read of the old thread is no line of the new one's receipt.
      this.forgetThread(channel);
      return this.pollOnce(channel, 0, limit, false, maxBytes);
    }
    // A cursor kept by a client that did not keep the thread's instance, aamio
    // 0.6.1 among them, cannot be checked against it: a thread opened again at
    // this address in the same second, with the same lifetime and list, looks
    // the same in every other field, and its first messages were passed over
    // without a word (a review of 10 November 2026). So the thread is read again
    // from the start, once, and all of it is handed over: what this channel
    // handed over before comes again marked replay, as after a restart. Nothing
    // is passed over by its hash, which is the hash of the text alone: another
    // sender's message with the same text has it too (the same review).
    if (!another && !data.reset && channel.after > 0 && typeof channel.instance !== "string" && instance !== null) {
      this.note(channel.label, "reread", `this channel's cursor, ${channel.after}, was kept by a client that did not keep the thread's instance, so it cannot be told whether the thread here is the one that cursor was kept on. It is read again from the start this once: what this channel handed over before comes again, marked replay, or replay_unknown where an earlier version kept it without who sent it, and nothing is passed over.`, channel.w);
      channel.after = 0;
      return this.pollOnce(channel, 0, limit, false, maxBytes);
    }
    if (data.reset) {
      this.note(channel.label, "restarted", (isObject(data.reset) && data.reset.what) || "the service read this thread from the start", channel.w);
      this.observed.delete(channel.w);
    }
    // The channel follows the thread that is there, all of it at once: one
    // taken up after its cursor was forgotten, or read from the start by the
    // service after a restart, may expire at another time than the one opened.
    // A channel that took the new instance and kept the old expiry chose an
    // inbox that had expired, and one that expired later was given up early
    // (a review of 10 November 2026). The list this channel was opened with is
    // its own, and stays.
    if ((channel.created_at === null || another || data.reset) && expires !== null) channel.expire_at = expires;
    channel.created_at = created;
    if (instance !== null) channel.instance = instance;
    // What the service kept back. It answers a byte budget with whole messages
    // only, so a message larger than the budget is named here and stays at the
    // service, with what came after it waiting behind it.
    if (isObject(data.too_large)) {
      this.note(channel.label, "too_large", `message ${data.too_large.seq} on this channel is ${data.too_large.bytes} bytes and does not fit the byte budget this read asked for, so it was not sent. It is still there, what was written after it waits behind it, and every read at this budget will leave it. Read again with a larger budget to take it: max_bytes over MCP, or --max-bytes on the command line.`, channel.w);
    }

    const entries = [];
    const keptOut = [];
    let lastSeq = null;
    // The budget is kept here as well, for what is handed over, measured as it
    // is handed over. The service counts its own form of each message, which is
    // not the size of the message opened here, and a service without read
    // limits sends everything: 512 bytes asked for, 628 handed over (a review of
    // 10 November 2026). A row that does not fit is not taken at all. It is not
    // observed for the receipt, not remembered as read and binds no address, and
    // the cursor stays before it, so the next read asks the service for it.
    let used = 0;
    let stoppedAtBudget = false;
    let oversized = null;
    for (const raw of data.messages) {
      if (limit !== null && entries.length >= limit) break;
      const entry = this.readEntry(channel, raw);
      const allow = channel.allow || [];
      const excluded = allow.length > 0 && !(entry.verified && (allow.includes("*") || allow.includes(entry.from_key)));
      // What the message's addresses would bind is worked out before it is
      // weighed, so a conflict it carries is counted with it, and bound only when
      // it is taken: a conflict added after the weighing let 1146 bytes through a
      // budget of 900 (a review of 10 November 2026).
      const bindings = [];
      if (!excluded) {
        this.takeScopeShare(entry);
        if (isObject(entry.body) && entry.verified && entry.from_key) {
          for (const field of ["reply_to", "channel"]) {
            const planned = this.bindingFor(field, entry.body[field], entry.from_key);
            if (planned !== null) bindings.push(planned);
          }
          const conflicts = bindings.filter((planned) => planned.conflict !== null).map((planned) => planned.conflict);
          if (conflicts.length) entry.binding_conflicts = conflicts;
        }
        if (maxBytes !== null) {
          const weight = Buffer.byteLength(JSON.stringify(entry), "utf8");
          if (entries.length > 0 && used + weight > maxBytes) {
            stoppedAtBudget = true;
            break;
          }
          // Alone and still over the budget: it has come, so it is handed over
          // on its own rather than kept back for ever, and that is said.
          if (entries.length === 0 && weight > maxBytes) oversized = { seq: entry.seq, weight };
          used += weight;
        }
      }
      // Every message read counts for the receipt, the ones the list keeps out too.
      this.observe(channel, raw, entry);
      lastSeq = lastSeq === null ? entry.seq : Math.max(lastSeq, entry.seq);
      if (excluded) {
        keptOut.push(entry.seq);
        continue;
      }
      if (entry.sha256 !== null) remember(channel, entry.sha256, entry.from_key);
      for (const planned of bindings) {
        if (planned.conflict === null) {
          this.state.peers[planned.address] = entry.from_key;
        } else {
          this.note(channel.label, "binding_conflict", `message ${entry.seq} names ${planned.address} as ${planned.field}, signed by ${this.nameForKey(entry.from_key) ?? entry.from_key}, and that address is already bound to ${this.nameForKey(planned.conflict.bound_to) ?? planned.conflict.bound_to}. The binding is kept.`, channel.w);
        }
      }
      entries.push(entry);
    }
    // Messages whose bytes this channel handed over before, which an earlier
    // version recorded without who sent them: whether each is a copy cannot be
    // told, and it is said rather than guessed.
    const unknown = entries.filter((entry) => entry.replay_unknown).map((entry) => entry.seq);
    if (unknown.length) {
      this.note(channel.label, "replay_unknown", `message(s) ${unknown.join(", ")} carry the bytes of a message this channel handed over before, which an earlier version recorded without who sent it, so whether each is a copy cannot be told: each comes with replay false and replay_unknown true.`, channel.w);
    }
    if (keptOut.length) {
      const openedFor = (channel.allow || []).includes("*") ? "any key, signed only" : `${channel.allow.length} named key(s)`;
      this.note(channel.label, "kept_out", `${keptOut.length} message(s) (seq ${keptOut.join(", ")}): this channel was opened for ${openedFor}, and these did not satisfy that list as checked here. They are not handed over.`, channel.w);
    }
    if (oversized) {
      this.note(channel.label, "over_budget", `message ${oversized.seq} on this channel is ${oversized.weight} bytes as handed over here, larger than the whole byte budget of ${maxBytes} this read asked for. It had already come, so it is handed over on its own rather than kept back for ever, and this read is over its budget on purpose.`, channel.w);
    }
    // Rows the service sent that this read left because its own limit was
    // reached: a service that does not take X-Limit sends them all, and the read
    // that stopped on its own said nothing (a review of 10 November 2026).
    const leftHere = !stoppedAtBudget && limit !== null && entries.length >= limit && data.messages.length > entries.length + keptOut.length;
    if (stoppedAtBudget) {
      this.note(channel.label, "more", `this read stopped at the byte budget it asked for, ${maxBytes} bytes of messages as they are handed over here, and left the rest at the service. Nothing was passed over: the cursor stands at the last message handed over, so read again for the rest.`, channel.w);
    } else if (leftHere || (data.more === true && !isObject(data.too_large))) {
      // The service says more both when the count this read asked for was
      // reached and when the byte budget was. A note that blamed a budget
      // nobody set would send the reader looking for the wrong cause.
      const atLimit = leftHere || (limit !== null && data.messages.length >= limit);
      this.note(channel.label, "more", atLimit
        ? "this read handed over as many messages as its limit allows, and the service has more waiting on this channel. Nothing was passed over: the cursor stands at the last message handed over, so read again for the rest."
        : maxBytes !== null
          ? "the service had more waiting on this channel than the byte budget this read asked for, so it sent what fits and kept the rest. Read again for it: the cursor stands at the last message handed over."
          : "the service says it has more waiting on this channel than it sent. Nothing was passed over: the cursor stands at the last message handed over, so read again for the rest.", channel.w);
    }
    // A read that stopped early moves the cursor to the last row it took and
    // no further: next would skip the rest of the page.
    const stoppedEarly = stoppedAtBudget || leftHere;
    if (stoppedEarly) {
      if (lastSeq !== null) channel.after = lastSeq;
    } else if (Number.isInteger(data.next)) channel.after = data.next;
    else if (lastSeq !== null) channel.after = Math.max(channel.after, lastSeq);
    await this.saveRead();
    return entries;
  }

  /**
   * The receipt for one channel, and two checks of it that are not one. Whether
   * its own lines hash to the root it claims can always be checked:
   * root_adds_up. Whether it agrees with what this process read can be, when
   * this process holds every message it counts: local_root_matches, null when
   * it holds fewer, which is not a failure, and false when it holds more. A
   * signer the service names is shown by name only when this process checked
   * that signature itself. The receipt is signed with this home's key as it
   * was fetched, which records what was taken, not that its claims are true.
   * With anchor, and only then, its root goes to Verifyum, with the same
   * idempotency key aamio-python and aamio-php use.
   */
  async receipt(label = "inbox", { anchor = false } = {}) {
    const channel = this.channel(String(label));
    if (!isObject(channel)) {
      const labels = this.state.channels.filter(isObject).map((c) => c.label);
      throw runtimeError("unknown_channel", `no channel called ${label} in this home. It has ${labels.length ? labels.join(", ") : "none yet: a read opens the inbox"}. A message names the channel it came on.`);
    }
    let data;
    try {
      ({ receipt: data } = await this.client.receipt({ id: channel.read_key, w: channel.w }));
    } catch (error) {
      throw runtimeError("receipt_failed", `the receipt could not be taken: ${error.status ?? 0} ${JSON.stringify(error.body ?? error.message)}`, { status: error.status ?? 0 });
    }
    // Checked as a receipt for this channel before anything is compared,
    // signed or anchored.
    const fault = receiptFault(data, channel.w);
    if (fault !== null) {
      throw runtimeError("receipt_failed", `the service's answer is not a receipt for this channel: ${fault}. Nothing was compared, signed or anchored.`);
    }
    // What this process read counts only for the thread it was read on. After
    // the service restarted, a new thread at the same address was compared with
    // what was read of the old one, and its signer named as checked here.
    const observed = this.observed.get(channel.w);
    // The same thread by its instance where the service names one, and by when
    // it was opened and expires where it does not.
    const sameThread = observed !== undefined && (typeof data.instance === "string" && observed.instance !== null
      ? observed.instance === data.instance
      : observed.created_at !== null && observed.created_at === data.created_at && (observed.expire_at === null || observed.expire_at === data.expire_at));
    const earlier = observed !== undefined && !sameThread && observed.rows.size > 0 ? observed : null;
    const entries = sameThread ? [...observed.rows.values()].sort((a, b) => a.seq - b.seq) : [];
    const which = (thread) => (typeof thread.instance === "string" ? `instance ${thread.instance}, ` : "the one ") + `opened at ${thread.created_at} and expiring at ${thread.expire_at}`;
    const held = entries.length;
    const line = (m) => `${m.seq}\t${m.at}\t${m.sha256}\t${m.from ?? "-"}\n`;
    const listed = data.messages.map(line).join("");
    const ours = entries.map(line).join("");
    const comparable = held === data.count;
    // A signer is named only for a row this process checked and the receipt
    // lists as it was read: the same seq, time, hash and signer. A row read on a
    // thread the fields cannot tell from this one is not taken for it (a review
    // of 10 November 2026).
    const listedBySeq = new Map(data.messages.map((m) => [m.seq, m]));
    const asListed = (e) => {
      const m = listedBySeq.get(e.seq);
      return m !== undefined && m.at === e.at && m.sha256 === e.sha256 && (m.from ?? null) === (e.from ?? null);
    };
    const verifiedKeys = new Set(entries.filter((e) => e.verified && typeof e.from_key === "string" && asListed(e)).map((e) => e.from_key));
    const claimed = Array.isArray(data.keys) ? data.keys : [];
    const unverified = claimed.filter((key) => typeof key !== "string" || !verifiedKeys.has(key));
    const attestation = `aamio-receipt-v1\n${channel.w}\n${data.root}\n${data.count}\n${data.issued_at ?? 0}`;
    const result = {
      label: channel.label, w: channel.w, root: data.root, commitment: data.commitment ?? null, count: data.count,
      keys: claimed.map((key) => (typeof key === "string" && verifiedKeys.has(key) ? this.nameForKey(key) ?? key : key)),
      keys_unverified_count: unverified.length, keys_service_claim_only: unverified,
      root_adds_up: sha256hex(listed) === data.root, held_locally: held,
      local_root_matches: comparable ? sha256hex(ours) === data.root : held > data.count ? false : null,
      signed_by: this.keys.public, signature: this.keys.sign(attestation), signed_text: attestation, receipt: data,
    };
    if (comparable) {
      const local = new Map(entries.map((e) => [e.seq, e]));
      result.local_differences = (data.messages ?? []).map((m) => {
        const seen = local.get(m.seq);
        return { seq: m.seq, fields: ["at", "sha256", "from"].filter((field) => !seen || (seen[field] ?? null) !== (m[field] ?? null)) };
      }).filter((difference) => difference.fields.length);
      result.signers_not_verified_locally = entries.filter((e) => e.from && !e.verified).map((e) => e.seq);
    }
    if (held > data.count) {
      result.local_check = "Mismatch: the receipt counts fewer messages than this process read. The thread was replaced or the service lost messages.";
    } else if (!comparable) {
      result.local_check = `Not compared: this process holds ${held} of the ${data.count} messages the receipt counts, so a local root would differ for a reason that is not the receipt's.`
        + (earlier !== null ? ` What this process read at this address was on another thread, ${which(earlier)}; this receipt is for ${which(data)}, so none of that counts here.` : "")
        + " root_adds_up checks only the receipt's arithmetic; our signature records what was fetched, not that its claims are true. For the independent check, take the receipt in the process that read the messages.";
    }
    if (anchor === true) {
      const idempotencyKey = sha256hex(`aamio-listen:${this.keys.hash}:${data.root}`).slice(0, 32);
      try {
        const proof = await this.client.anchor(`sha256:${data.root}`, { endpoint: this.verifyum, idempotencyKey });
        result.anchor = { proof_id: proof.proofId, proof_url: proof.proofUrl ?? null, status: proof.status ?? null, commitment: proof.commitment };
      } catch (error) {
        // The receipt stands; only the anchoring failed, and it says how: the
        // HTTP status, 0 when nothing answered, and Verifyum's own words when
        // its tool answered with an error.
        const said = error.body?.result?.content?.[0]?.text;
        result.anchor = { error: error.status ?? 0, detail: typeof said === "string" ? said : error.body ?? error.message };
      }
    }
    return result;
  }

  /** Messages on every channel still read, the inbox first. The inbox is opened and presence published as the read starts. */
  async read({ wait = 0, limit = 50, maxBytes = null } = {}) {
    const noted = this.attention.length;
    await this.ensureInbox();
    await this.publishPresence();
    const now = this.now();
    // What was read of a thread is kept for its receipt while the receipt can
    // still be taken, and no longer: a server that ran for days held the rows
    // of every inbox it had read (a review of 10 November 2026).
    for (const w of [...this.observed.keys()]) {
      const known = this.state.channels.find((c) => isObject(c) && c.w === w);
      if (!known || Number(known.expire_at) + RECEIPT_KEEP < now) this.observed.delete(w);
    }
    const channels = this.state.channels.filter((c) => isObject(c) && !c.muted && Number(c.expire_at) > now)
      .sort((a, b) => (a.label === "inbox" ? -1 : b.label === "inbox" ? 1 : 0));
    const messages = [];
    // A channel this read had no room left to ask is named, as aamio-python
    // names it: what waits there was not looked at, and a read that stopped at
    // its limit is not a read of everything.
    const notAsked = [];
    const notAskedAfter = [];
    // Every channel without waiting first: a message on an older inbox that
    // is still read is handed over at once, not after a wait on the new one.
    // The byte budget is per channel, as in aamio-python: one split between
    // them would refuse a message that fits.
    for (const channel of channels) {
      if (messages.length >= limit) {
        notAsked.push(channel);
        continue;
      }
      messages.push(...(await this.poll(channel, 0, limit - messages.length, maxBytes)));
    }
    const inbox = this.channel("inbox");
    if (!messages.length && wait > 0 && inbox && !inbox.muted) {
      messages.push(...(await this.poll(inbox, wait, limit, maxBytes)));
      // What reached the other channels during the wait comes with this
      // answer, as in aamio-python: only the inbox can end the wait early. It
      // used to wait for the next read (a review of 9 November 2026).
      for (const channel of channels) {
        if (channel === inbox) continue;
        if (messages.length >= limit) {
          notAskedAfter.push(channel);
          continue;
        }
        messages.push(...(await this.poll(channel, 0, limit - messages.length, maxBytes)));
      }
    }
    for (const channel of notAsked) {
      this.note(channel.label, "more", `this read reached its limit of ${limit} message(s) before it asked this channel, so what waits here was not looked at. Nothing was passed over: read again for it.`, channel.w);
    }
    for (const channel of notAskedAfter) {
      this.note(channel.label, "more", `this read reached its limit of ${limit} message(s) during the wait, so this channel was asked before the wait and not after it. What reached it meanwhile comes with the next read.`, channel.w);
    }
    // A read says a thing once. A channel asked before a wait and in it gave
    // the same too_large twice (a review of 10 November 2026).
    const said = new Set();
    const fresh = this.attention.slice(noted).filter((note) => {
      const key = `${note.w}\u0000${note.state}\u0000${note.what}`;
      if (said.has(key)) return false;
      said.add(key);
      return true;
    });
    this.attention.splice(noted, this.attention.length - noted, ...fresh);
    return messages;
  }
}
