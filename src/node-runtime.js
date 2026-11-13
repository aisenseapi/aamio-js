import { open, readFile, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Aamio, AamioError, BOARD_POST_MARGIN, BOARD_TTL, DEFAULT_BASE, DEFAULT_BOARD, GateStop, VERIFYUM_MCP, checkMessage, gatePlan, isEnvelope, isKey, keyHash, newScopeKey, scopeAddress, sha256hex, threadSigningInput } from "./aamio.js";
import { DEFAULT_POLICY, appendRecord, archiveName, archiveNames, archiveStatus, archivedRecords, isSafeLabel, pruneArchive, readPolicy } from "./node-archive.js";
import { readKeys } from "./node-identity.js";
import { takeHome } from "./node-lock.js";
import { SCOPE_NOT_SAVED, checkAccess, checkScopeName, longerForm, removedShares, scopeAddPlan, scopeCalled, scopeRemovePlan, scopeView, sharedScopeName, takenFrom, usableScopes, withoutScopeKey } from "./node-scopes.js";
import { TRACE_KEEP, TRACE_KEYS, TRACE_READ_FIELDS, TRACE_RECEIVED_FIELDS, TRACE_SENT_FIELDS, isMessageHash, normalizeTraces, traceRow, traceView } from "./node-trace.js";

/*
 * The local runtime for Node: a home held for as long as it runs, an inbox the
 * partners can write to, presence that says where it is, sends written to an
 * outbox before they go, and reads checked here before anything is handed on.
 *
 * A home is shared with aamio-python and aamio-php, so the files are theirs:
 * partners.json, scopes.json, state.json, outbox.json and trace.json in the
 * same shape, written the same way, and archive/ with what was read, sent
 * and posted, under the policy in config.json. A home one of them made opens
 * here, and one this makes opens there. What Python keeps that this does not
 * touch yet, effects, is left as it is.
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
const KEPT_FILES = ["partners.json", "scopes.json", "state.json", "outbox.json"];
// The largest X-Max-Bytes the service takes: one to eight digits.
const MAX_BYTES_HEADER = 99_999_999;
// How long after a thread expires what this process read of it is kept for its
// receipt: the service keeps an expired thread for a best-effort minute of grace
// for receipts, and the margin is for clocks that differ.
const RECEIPT_KEEP = 120;
// Answers that prove a message was not stored: refusals the service will give
// again, and a rate window, which it decides before it reads the body.
// 401 and 409 are among them: a signature that does not verify over these
// bytes, a thread that is full, a key that has used up the gate's per_key. The
// service answers each before it stores anything. Left out, a handover
// answered so said the address may have arrived, and retry sent the same
// bytes to the same refusal (a check of 12 November 2026).
const SEND_DETERMINISTIC = [400, 401, 403, 409, 410, 413, 415, 422, 428, 501];
const SEND_NOT_STORED = [...SEND_DETERMINISTIC, 429];
// Nothing about the message is wrong, only the moment: a rate window, or a
// service that is busy. 503 is not among the answers that prove nothing was
// stored: it can be a front door that saw nothing or the service failing after
// it had written, and this side cannot tell which.
const SEND_TRY_LATER = [429, 503];
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
// Counted in characters, as aamio-python and aamio-php count a name: without
// the u flag a name of 33 emoji was 66 units here and refused, and taken there
// (a check of 13 November 2026).
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/u;

// ------------------------------------------------------------- the outbox --
//
// What happened to a send, read from its entry by the rules aamio-python and
// aamio-php read it by, so an outbox one of them wrote says the same here.

/**
 * Which of five things happened to a send, for a caller deciding whether to
 * replace it, or not_found. Only a stop before the first POST may be called
 * unsent. An attempt that was answered 500 does not prove the message is
 * absent, and one that was delivered is certainly not unsent.
 */
export function outboxOutcome(entry) {
  if (!isObject(entry)) return "not_found";
  const status = entry.status;
  // Read before the statuses: a retry sets the status back to working while
  // the first attempt is still with the other side.
  if (entry.posting && status === "working") return "attempted";
  if (status === "delivered") return "delivered";
  if (status === "unknown") return "unknown";
  if (status === "attempted") return "attempted";
  if (status === "refused") {
    // An earlier attempt that was left open is not undone by a later refusal.
    // An entry from before ever_open is read by its last answer.
    if (entry.ever_open) return "attempted";
    return SEND_NOT_STORED.includes(entry.last_status) ? "refused" : "attempted";
  }
  // posting is set in the moment before the post, by the runtimes that set
  // it: the one mark that means bytes were on their way.
  if (entry.posting) return "attempted";
  if (status === "working" || status === "stopped") return "never_sent";
  return Number(entry.attempts) > 0 ? "attempted" : "never_sent";
}

/** Whether this message still has something to decide: it left, and what came back settles nothing. */
export function outboxOpen(entry) {
  return ["attempted", "unknown"].includes(outboxOutcome(entry));
}

/**
 * Whether sending these same bytes again is the right next move. Not the same
 * question as open: a rate window is settled, nothing was stored, and it is
 * also the one refusal whose advice is to wait and send it again. A refusal
 * the service will repeat is not here, and a delivery is not here.
 */
export function outboxRetryable(entry) {
  if (!isObject(entry)) return false;
  if (outboxOpen(entry)) return true;
  return outboxOutcome(entry) === "refused" && SEND_TRY_LATER.includes(entry.last_status);
}

export const OUTBOX_NOTES = {
  never_sent: "nothing had left this machine for it, and nothing will now",
  attempted: "a send was attempted and its answer does not prove the message is absent, so its outcome stays unknown and nothing here can recall it",
  delivered: "the service had already stored it when this was dropped; dropping the entry does not unsend it",
  refused: "the service answered that it refused this one, so it was not stored, but the attempt did leave this machine",
  unknown: "a send was already away when this was dropped, so its outcome stays unknown and nothing here can recall it",
  not_found: "this outbox has no message with that id, so nothing was dropped and nothing was sent",
};

/**
 * What to do about a send that did not end in a stored message: whether the
 * same stored bytes are worth sending again, and the fix in words. true: the
 * message is fine and the moment was not. false: the same message will fail
 * the same way. null: it cannot be decided from what is known here. Never a
 * permission to repeat something by itself. The words are aamio-python's.
 */
export function sendAdvice(outcome, status) {
  if (outcome === "never_sent") {
    return [false, "Nothing left this machine for this message, so it was not delivered and will not be: the error says what stopped it. Put that right, then send it as a new message. There is nothing to retry."];
  }
  if (outcome === "unknown") {
    return [null, "No answer came back, so this message may already have been delivered. Keep its message_id. aamio_pending lists what has no settled outcome on this machine; it does not confirm delivery, and nothing here can, because the address it went to is not yours to read. Do not pass the message_id to aamio_send and do not compose a replacement. An approved retry sends the stored bytes again: aamio_outbox_retry with this id, or aamio outbox retry --id on the command line."];
  }
  if (SEND_TRY_LATER.includes(status)) {
    return [true, `aamio declined this for now, not because of the message: ${status} is a rate window or a busy service. Do not change the content. Wait, then send the stored message again through the runtime's outbox retry rather than composing a new one.`];
  }
  if (SEND_DETERMINISTIC.includes(status)) {
    return [false, "aamio refused this and will refuse the same bytes again. Read the error, correct the request, and send the corrected one as a new message."];
  }
  return [null, `aamio answered ${status}, which this client does not classify. It may or may not have stored the message before failing, so treat delivery as unsettled: keep the message_id, read the error, and do not resend blindly.`];
}

// Said with a stop that came while a message was being sent again. The stop
// is that attempt's: the one before it is still with the other side, and the
// words of a message that never left, "not sent, send it again", read as leave
// to write it anew (a check of 12 November 2026).
const EARLIER_ATTEMPT = "An earlier attempt of it left this machine and may have arrived, so its outcome is still unknown.";
const RETRY_SAME_ID = "retry the same message: aamio_outbox_retry with this id, or aamio outbox retry --id on the command line. That sends the stored bytes again, which a recipient that keeps what it has seen marks a replay. Do not compose a replacement, and do not send the text as a new message.";

/** The codes of a send that did not end in a stored message. Each is said with its message id and its outcome. */
export const SEND_STOPS = ["send_failed", "not_sent", "retry_not_sent"];

/**
 * What such a stop says of itself beside its words, for the command line and
 * the local server alike. The two wrote these fields out separately, and the
 * trace that could not be written was in neither: a command that sends once
 * and exits never saw it (a check of 12 November 2026).
 */
export function stopFields(error) {
  const said = {};
  for (const field of ["outcome", "message_id", "status"]) if (error?.[field] !== undefined) said[field] = error[field];
  for (const field of ["outbox_error", "trace_error", "archive_error"]) if (error?.[field]) said[field] = error[field];
  // Whether the same stored bytes are worth sending again: true, false, or null when it cannot be told.
  if (error?.retryable !== undefined) said.retryable = error.retryable;
  if (error?.earlier_attempt) said.earlier_attempt = error.earlier_attempt;
  // A channel that is open although the message carrying its address was stopped, or left and has no settled outcome.
  if (isObject(error?.opened)) said.opened = error.opened;
  return said;
}

// How long a channel lives: what the service takes for a thread of its own.
export const CHANNEL_TTL = 600;
const CHANNEL_TTL_MIN = 30;
const CHANNEL_TTL_MAX = 3600;

const GATE_SHAPE = 'A gate is an object with "require", "advise" or both, as in {"require": {"pow": {"bits": 20}, "per_key": 5}}. require refuses a write that does not meet it; advise lets the write in and reports on it.';

/**
 * The shape of a gate, refused here rather than a round trip later. Only the
 * shape: what the numbers may be is the service's to decide, and its refusal
 * carries the detail. Worth catching before the call because a gate is set
 * once, when the channel is opened, and never changes: one that went nowhere
 * leaves a channel open for its whole life without the conditions its owner
 * meant it to have. Throws invalid_gate.
 */
export function checkGate(gate) {
  if (!isObject(gate)) throw runtimeError("invalid_gate", `a gate must be an object, not ${Array.isArray(gate) ? "a list" : gate === null ? "null" : typeof gate}. ${GATE_SHAPE}`);
  const unknown = Object.keys(gate).filter((key) => key !== "require" && key !== "advise").sort();
  if (unknown.length) throw runtimeError("invalid_gate", `a gate has no field ${unknown.join(", ")}. ${GATE_SHAPE}`);
  if (!Object.keys(gate).length) throw runtimeError("invalid_gate", `an empty gate asks for nothing; leave the gate out instead. ${GATE_SHAPE}`);
  for (const key of ["require", "advise"]) {
    if (key in gate && !isObject(gate[key])) throw runtimeError("invalid_gate", `gate.${key} must be an object. ${GATE_SHAPE}`);
  }
  return gate;
}

/**
 * A label for a channel of the caller's own. It names the channel in every
 * answer and its file in the archive, so it is made of what a file's name may
 * hold and nothing else: a label with a path in it put what was read on the
 * channel outside the home. The labels that start with inbox or board are
 * the runtime's own channels. Throws invalid_label.
 */
export function checkLabel(label) {
  if (!isSafeLabel(label)) {
    throw runtimeError("invalid_label", "a channel's label is 1 to 64 letters, digits, dots, dashes and underscores, starting with a letter or a digit, and not a name the system keeps for a device: it names the channel's file in the archive");
  }
  if (/^(?:inbox|board)/i.test(label)) throw runtimeError("invalid_label", `the label ${label} is the runtime's own: a label that starts with inbox or board names an inbox or a board inbox. Choose another`);
}

/** How long a channel is to live, as a whole number of seconds the service takes. Throws invalid_ttl. */
export function checkChannelTtl(ttl) {
  if (!Number.isInteger(ttl) || ttl < CHANNEL_TTL_MIN || ttl > CHANNEL_TTL_MAX) throw runtimeError("invalid_ttl", `a channel lives a whole number of seconds from ${CHANNEL_TTL_MIN} to ${CHANNEL_TTL_MAX}`);
  return ttl;
}

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

/** Presence tags from a comma-separated list, as aamio-python reads --tags and AAMIO_TAGS. */
export function tagsFrom(text) {
  return String(text ?? "").split(",").filter(Boolean);
}

export class NodeRuntime {
  /** Takes the home, reads its key and its files. Close it to let go. */
  static async open({ home, host = process.env.AAMIO_HOST || DEFAULT_BASE, board = process.env.AAMIO_BOARD || DEFAULT_BOARD, verifyum = process.env.AAMIO_VERIFYUM || VERIFYUM_MCP, fetch = globalThis.fetch, clock = () => Date.now() / 1000, archive = null, tags } = {}) {
    const owner = await takeHome(home, { host });
    try {
      const runtime = new NodeRuntime({ home, host, board, verifyum, keys: await readKeys(home), owner, fetch, clock, archive });
      await runtime.load();
      // The tags presence publishes, taken as aamio-python and aamio-php take
      // them: the ones given now, else the home's own, else AAMIO_TAGS. They
      // are the home's from the next save on. This runtime had no way to set
      // them (a check of 13 November 2026).
      if (Array.isArray(tags)) runtime.state.tags = tags;
      else if (!runtime.state.tags.length) runtime.state.tags = tagsFrom(process.env.AAMIO_TAGS || "");
      return runtime;
    } catch (error) {
      await owner.release();
      throw error;
    }
  }

  constructor({ home, host, board = DEFAULT_BOARD, verifyum = VERIFYUM_MCP, keys, owner, fetch, clock, archive = null }) {
    this.home = home;
    // The archive is the home's own choice, kept in config.json: keep, off or
    // so many days. archive false turns it off for this process, which is
    // what --no-archive does, and true turns it on whatever the home says.
    this.archiveAsked = archive;
    this.archivePolicy = { ...DEFAULT_POLICY };
    this.archiveEnabled = false;
    this.prunedAt = 0;
    // What this process read on each channel, by write address, as it was
    // handed over, with the thread's instance and the archive's mark: what
    // board replies lists beside the archive. In memory only, and gone with
    // the channel.
    this.received = new Map();
    // Messages the archive holds from a read whose cursor could not be
    // written: read again, they are not written down a second time.
    this.writtenDown = new Set();
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
    // What was sent to each counterpart and what came back, as hashes and
    // shapes: trace.json, a book per public key.
    this.traces = {};
    // The scopes this home holds, and the entries of scopes.json that are not
    // scopes this runtime can use, which go back into the file as they were.
    this.scopes = [];
    this.scopesAside = [];
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
      // The decoder drops one byte order mark at the start, which is how a
      // file of the home is read by all three runtimes.
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
    const scopes = usableScopes(await this.loadJson("scopes.json", [], Array.isArray));
    this.scopes = scopes.usable;
    this.scopesAside = scopes.aside;
    if (scopes.unusable) this.note("scopes", "scopes_unusable", `scopes.json: ${scopes.unusable} entries are not scopes this runtime can use, and stay in the file as they are`);
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
    this.traces = normalizeTraces(await this.loadTrace(), TRACE_KEEP, TRACE_KEYS);
    this.dropExpired();
    this.archivePolicy = await readPolicy(this.home);
    this.archiveEnabled = this.archiveAsked === null || this.archiveAsked === undefined ? this.archivePolicy.mode !== "off" : Boolean(this.archiveAsked);
    await this.prune();
    await this.settleInterrupted();
  }

  /**
   * Channels past their time leave the home. The thread is gone at the
   * service with everything on it, and what was read of it is kept for its
   * receipt for as long as the receipt can be taken. The inbox and the board
   * inbox stay until a new one takes their place, so a command can say that
   * the address closed, and when. Left in state.json, every inbox this home
   * ever had was written again at each save. In memory: the file follows at
   * the next save.
   */
  dropExpired() {
    const now = this.now();
    const gone = (channel) => isObject(channel) && channel.label !== "inbox" && channel.label !== "board" && Number(channel.expire_at) + RECEIPT_KEEP <= now;
    for (const channel of this.state.channels.filter(gone)) {
      this.received.delete(channel.w);
      // And what was written down of it at a read that could not be saved: it will not be read again.
      for (const delivery of this.writtenDown) if (delivery.startsWith(channel.w + "\u0000")) this.writtenDown.delete(delivery);
    }
    this.state.channels = this.state.channels.filter((channel) => !gone(channel));
  }

  // ----------------------------------------------------------- archive --
  //
  // What was read, sent and posted, decrypted, in archive/: one file per
  // channel, one record per line, as aamio-python and aamio-php keep it. It
  // is a record of what happened and never the thing itself: a write that
  // fails costs the record, and is said, and the message, the send or the
  // post it is about stands.

  /** Removes what the policy no longer keeps. A failure is said, since the archive then keeps growing in plain text. */
  async prune() {
    const policy = this.archivePolicy;
    if (!this.archiveEnabled || !(policy.days || policy.max_mb)) return;
    this.prunedAt = this.now();
    try {
      await pruneArchive(this.home, policy, { now: this.now() });
    } catch (error) {
      this.note("archive", "unpruned", `the archive was not pruned: ${error.code || error.name}: ${error.message}. It keeps growing, and what is in it stays readable to whoever can read this folder.`);
    }
  }

  /**
   * Writes one record, and says whether it wrote one. A home that keeps
   * nothing is not a failure, and it is not a write either. Throws when the
   * write fails: the caller knows what the record was about.
   */
  async archive(label, record) {
    if (!this.archiveEnabled || this.closed) return false;
    await appendRecord(this.home, archiveName(label), record);
    if (this.now() - this.prunedAt > 3600) await this.prune();
    return true;
  }

  /** The same for a record of something that is done already: what went wrong is given back, said in attention, and never thrown. */
  async archiveSafely(label, record, what) {
    try {
      await this.archive(label, record);
      return null;
    } catch (error) {
      const how = `${error.code || error.name}: ${error.message}`;
      this.note("archive", "archive_failed", `${what} could not be written to the archive: ${how}. The archive does not have it.`);
      return how;
    }
  }

  /** One message of one thread, as this process knows a row it wrote down: the address, the thread's instance where the service names one, the seq and the hash. */
  deliveryOf(channel, entry) {
    return entry.sha256 === null || entry.sha256 === undefined ? null : [channel.w, typeof channel.instance === "string" ? channel.instance : "-", entry.seq, entry.sha256].join("\u0000");
  }

  /**
   * What the archive holds now and what its policy means. Off stops the
   * writing and removes nothing: what was kept before is still there, in the
   * clear, and the words for off say nothing of it, so this does.
   */
  async archiveStatus() {
    const status = await archiveStatus(this.home, this.archivePolicy);
    if (this.archivePolicy.mode === "off" && status.files > 0) {
      status.note = `Nothing more is written. What was kept before the archive was turned off is still in archive/: ${status.files} file(s), ${status.bytes} bytes. aamio archive prune --all removes it.`;
    }
    return status;
  }

  /** Removes what the policy no longer keeps, or with everything the whole archive, and says how much went. */
  async archivePrune({ everything = false } = {}) {
    const gone = await pruneArchive(this.home, this.archivePolicy, { now: this.now(), everything });
    return { ...(await this.archiveStatus()), removed: gone.removed };
  }

  /**
   * The home's own choice, written where the next process finds it, in any of
   * the three runtimes. What config.json holds beside it stays. The choice
   * counts once the file holds it.
   */
  async archiveSet(policy) {
    let config = {};
    try {
      config = await this.loadJson("config.json", {}, isObject);
    } catch {
      // A config.json that cannot be read holds no choice anyone can use: it is replaced by this one.
      config = {};
    }
    try {
      await this.saveJson("config.json", { ...config, archive: policy });
    } catch (error) {
      if (error?.code === "runtime_closed") throw error;
      throw runtimeError("not_saved", `config.json could not be written (${error.code || error.message}), so the archive's policy is as it was. Free the disk, then set it again.`);
    }
    this.archivePolicy = policy;
    this.archiveEnabled = policy.mode !== "off";
    await this.prune();
    return this.archiveStatus();
  }

  /**
   * trace.json, or nothing when it is not there. The trace is diagnostics: a
   * file that cannot be read never stops the runtime, as aamio-python reads
   * it. It is said, since the next record written replaces the file.
   */
  async loadTrace() {
    let bytes;
    try {
      bytes = await readFile(join(this.home, "trace.json"));
    } catch (error) {
      if (error.code !== "ENOENT") this.untraced(`trace.json could not be read (${error.code || error.message}), so the trace starts empty and the next record replaces the file.`);
      return {};
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.trim() === "") return {};
      const value = JSON.parse(text);
      if (!isObject(value)) throw new Error("not a JSON object");
      return value;
    } catch (error) {
      this.untraced(`trace.json is not what a trace holds (${error.message}), so the trace starts empty and the next record replaces the file.`);
      return {};
    }
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
      // An attempt left open before this process, by this version or an older
      // one, stays open: a stop or a refusal from now on settles a later
      // attempt, not that one. Asked of the outcome and not of the status: an
      // entry an older client wrote as refused, after an answer that proved
      // nothing, had no mark, and a 410 on its retry called a message that may
      // have landed refused, and not stored (a check of 12 November 2026).
      if (outboxOpen(entry) && entry.ever_open !== true) {
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
        // What an older file coming back would mean is said for the file it is
        // true of: the cursor is in state.json, and no other file has one.
        this.note("files", "not_synced", `${name} was replaced, but the folder ${this.home} could not be synced (${error.code || error.message}). This runtime goes on with what it wrote. After a power cut an older ${name} could come back${name === "state.json" ? ", and what was read since would then be read again" : ""}.`);
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

  /**
   * Written when it changes. A trace that cannot be written costs the trace
   * and nothing else: the line that says so is given back, and null when the
   * file was written.
   */
  async saveTrace() {
    try {
      await this.saveJson("trace.json", this.traces);
      return null;
    } catch (error) {
      return this.untraced(`trace.json: ${error.code || error.name || "Error"}: ${error.message}`);
    }
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
   * The keys that signed a message this process read and verified, by its
   * hash. The same bytes may carry more than one. What this process checked
   * lives in its memory and not in state.json, so a message read by an
   * earlier process is not here. An observation the channel's allowlist kept
   * out is: a signature that checked is not a permission. An add-on is given
   * the key behind a message this way, and never a key from the conversation.
   */
  verifiedSigners(sha256) {
    const keys = [];
    for (const held of this.observed.values()) {
      for (const row of held.rows.values()) {
        if (row.sha256 === sha256 && row.verified === true && !keys.includes(row.from_key)) keys.push(row.from_key);
      }
    }
    return keys;
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
    await this.savePartners(next);
    return this.inboxAfterChange(`partner ${name} was added`, { partner: name, key });
  }

  /**
   * A partner out of the address book, and out of the inbox at once, as
   * aamio-python and aamio-php do it. Forgetting the name is not a
   * revocation: the service takes the removed key's writes to the old address
   * until that thread expires. So a new inbox opens without the key, and the
   * one that named it is read until it expires for the partners still in the
   * book, who may not have the new address yet, while what the removed key
   * writes there is not handed over. Once the last partner is gone the
   * new inbox takes signed writes from any key rather than unsigned writes
   * from anyone at an address the partners were given. The name finds the
   * partner the way a send does, apart from upper and lower case when only
   * one is so named.
   */
  async partnerRemove(name) {
    // A key or a name, as a send takes them: the refusal of an ambiguous name
    // says to give the key, and partner remove did not take one.
    const known = isKey(String(name)) ? this.partnerByKey(String(name)) : this.partnerByName(name);
    if (known === null) return { partner: String(name), known: false, inbox: this.channel("inbox")?.w ?? null };
    // The book counts only once partners.json holds it, as with partnerAdd.
    const next = this.partnersFile.filter((p) => !(isObject(p) && p.name === known.name));
    await this.savePartners(next);
    return this.inboxAfterChange(`partner ${known.name} was removed`, { partner: known.name, known: true });
  }

  /**
   * Writes the address book, and only then holds it. One that cannot be
   * written is said as not_saved, with the book as it was: the command line
   * said only that it could not complete the command.
   */
  async savePartners(next) {
    try {
      await this.saveJson("partners.json", next);
    } catch (error) {
      if (error?.code === "runtime_closed") throw error;
      throw runtimeError("not_saved", `partners.json could not be written (${error.code || error.message}), so the address book is as it was. Free the disk, or give this user write access to ${this.home}, then do it again.`);
    }
    this.partnersFile = next;
  }

  // ------------------------------------------------------------ scopes --
  //
  // A scope keeps board posts unlisted for a group. Each has a name here, and
  // the name is all a caller passes or sees. The key stays in scopes.json, and
  // scopeShare hands it to a partner sealed. Unlisted is not private.

  /** Writes the scopes, and only then holds them: a save that fails changes nothing. */
  async saveScopes(scopes, aside = this.scopesAside) {
    await this.saveJson("scopes.json", [...scopes, ...aside]);
    this.scopes = scopes;
    this.scopesAside = aside;
  }

  /** The same for a caller that asked for the change: what went wrong, and that nothing changed. */
  async keepScopes(scopes, aside, unchanged) {
    try {
      await this.saveScopes(scopes, aside);
    } catch (error) {
      if (error?.code === "runtime_closed") throw error;
      throw runtimeError("not_saved", `scopes.json could not be written (${error.code || error.message}), so ${unchanged}. Free the disk, then do it again.`);
    }
  }

  /** The scope with this name, apart from upper and lower case. Throws unknown_scope. */
  scopeNamed(name) {
    const entry = scopeCalled(this.scopes, name);
    if (entry === null) throw runtimeError("unknown_scope", `no scope called ${name} here. The scope list shows the ones this runtime holds`);
    return entry;
  }

  scopeList() {
    return this.scopes.map(scopeView);
  }

  /** A new scope, its key from the system's secure generator. The key stays here. */
  async scopeNew(name) {
    checkScopeName(name);
    if (scopeCalled(this.scopes, name) !== null) throw runtimeError("scope_exists", `there is a scope called ${name} already`);
    const key = newScopeKey();
    const entry = { name, key, address: scopeAddress(key) };
    await this.keepScopes([...this.scopes, entry], undefined, `scope ${name} was not made`);
    return scopeView(entry);
  }

  /** A scope made elsewhere: the key, to read and post, or the address, to post only. */
  async scopeAdd(name, { key = null, address = null } = {}) {
    const [held, keep] = scopeAddPlan(this.scopes, name, key ?? null, address ?? null);
    if (keep !== null) await this.keepScopes(keep, undefined, `scope ${name} was not kept`);
    return scopeView(held);
  }

  /**
   * Removes a scope, and remembers the invitations it came from in the same
   * write. The cursor and the hashes of what was read live in state.json and
   * the scope in scopes.json: an invitation that comes again as a message
   * never seen, after a state.json that could not be written, would bring a
   * removed scope back. Remembered here, the same one read again keeps
   * nothing. A new invitation is another message, and is taken.
   */
  async scopeRemove(name) {
    const entry = this.scopeNamed(name);
    const [scopes, aside] = scopeRemovePlan(this.scopes, this.scopesAside, entry);
    await this.keepScopes(scopes, aside, `scope ${entry.name} is still held`);
    return { removed: entry.name };
  }

  /** The key itself, for a person to pass on by hand. The local server never calls this. */
  scopeKey(name) {
    const entry = this.scopeNamed(name);
    if (!entry.key) throw runtimeError("scope_write_only", `scope ${entry.name} is held to post only, so there is no key here`);
    return { name: entry.name, key: entry.key, address: entry.address };
  }

  /**
   * Hands a scope to a partner in a sealed message. read gives the key, write
   * only the address. Only to a partner in the address book, by name or key:
   * an address is learned from the board and from messages, so it can be
   * anyone's, and the key would be sealed to whoever it was learned from. A
   * post asking for a scope would get it.
   */
  async scopeShare(name, to, access) {
    const entry = this.scopeNamed(name);
    checkAccess(access);
    if (access === "read" && !entry.key) throw runtimeError("scope_write_only", `scope ${entry.name} is held to post only, so it can only be shared with access write`);
    const partner = isKey(String(to)) ? this.partnerByKey(to) : this.partnerByName(to);
    if (!partner) throw runtimeError("unknown_partner", "a scope is shared only with a partner in your address book, by name. Never with an address, which can be anyone's");
    const share = access === "read" ? { name: entry.name, key: entry.key } : { name: entry.name, address: entry.address };
    // By the key, so the partner chosen stays chosen. The envelope is sealed
    // to it, and the outbox and the trace keep the envelope and the names of
    // the fields: the scope's key is in neither in the clear.
    const sent = await this.send(partner.key, { text: `Scope ${entry.name}, shared to ${access === "read" ? "read and post" : "post only"}.`, data: { aamio_scope: share }, archivedData: { aamio_scope: { name: entry.name, access } } });
    return { ...sent, scope: entry.name, access };
  }

  /** What an invitation is known by: the hash of its bytes and its signer, as seen_from records it, or null. */
  shareRecord(entry) {
    return typeof entry.sha256 === "string" && HASH.test(entry.sha256) ? seenRecord(entry.sha256, entry.from_key) : null;
  }

  /**
   * A scope in an incoming message, before the message is weighed, and before
   * anyone reads it. The key is taken out of the message whatever becomes of
   * the share, and aamio_scope is replaced wherever it sits and whatever it
   * holds, so whoever reads the message never sees a key in it.
   *
   * A share is taken only when it came sealed and verified from a partner in
   * the address book, in a message not seen before, and not from an
   * invitation whose scope was removed since. Nothing is kept here. What
   * taking it would write is given back, or null when nothing is to be taken,
   * and the message carries the longer of the two forms the share can end in,
   * kept or not saved: a message has to be the size it was weighed at.
   */
  scopeSharePlan(entry) {
    const body = entry.body;
    if (!isObject(body)) return null;
    if ("aamio_scope" in body) body.aamio_scope = { kept: false, note: "not kept: a scope is shared in data.aamio_scope" };
    const data = body.data;
    if (!isObject(data) || !("aamio_scope" in data)) return null;
    const share = data.aamio_scope;
    if (!isObject(share)) {
      data.aamio_scope = { kept: false, note: "not kept: data.aamio_scope is an object with name, and key or address" };
      return null;
    }
    const key = share.key ?? null;
    const view = { shared_as: typeof share.name === "string" ? share.name : null, can_read: key !== null, kept: false };
    const partner = entry.from_key ? this.partnerByKey(entry.from_key) : null;
    const invitation = this.shareRecord(entry);
    let why = null;
    if (!(entry.verified && entry.encrypted && entry.known_contact && partner !== null)) {
      why = "not kept: a scope is only taken when it comes sealed from a partner in your address book";
    } else if (entry.replay) {
      why = "not kept again: this message arrived before, and a scope removed since stays removed";
    } else if (entry.replay_unknown) {
      why = "not kept: these bytes arrived here before, recorded by an earlier version without who sent them, so this may be that message again, and a scope removed since stays removed";
    } else if (invitation !== null && removedShares(this.scopesAside).has(invitation)) {
      why = "not kept again: this invitation was taken here before, and its scope was removed since. A scope removed stays removed: ask for it to be shared again";
    }
    if (why !== null) {
      data.aamio_scope = { ...view, note: why };
      return null;
    }
    let held;
    let keep;
    let plain;
    try {
      const local = sharedScopeName(partner, share.name);
      [held, keep] = scopeAddPlan(this.scopes, local, key, key !== null ? null : share.address ?? null);
      // Held already: nothing but the record of this invitation to write.
      plain = keep === null;
      // The invitation goes with the scope, in the same write, so that
      // removing the scope can remember it.
      if (invitation !== null && !takenFrom(held).includes(invitation)) {
        const before = held;
        held = { ...before, taken_from: [...takenFrom(before), invitation] };
        keep = (keep ?? this.scopes).map((scope) => (scope === before ? held : scope));
      }
    } catch (error) {
      // This share alone. The rest of the messages are handed over either way.
      data.aamio_scope = { ...view, note: `not kept: ${error.message}` };
      return null;
    }
    const shown = { ...view, ...scopeView(held), kept: true };
    const unsaved = { ...view, note: SCOPE_NOT_SAVED };
    data.aamio_scope = longerForm(shown, unsaved);
    return { data, held, keep, plain, shown, unsaved, shared: share.name };
  }

  /**
   * The share of a message that is taken: scopes.json is written, and the
   * message says kept, or it could not be, and the message says so in the form
   * it was weighed at while attention says why. Written before the cursor is:
   * a process that stops between the two reads the message again and finds
   * the scope held, where the other order would have passed the message by
   * with the scope not kept and nothing said.
   */
  async scopeShareTake(entry, plan, said) {
    try {
      if (plan.keep !== null) await this.saveScopes(plan.keep);
      plan.data.aamio_scope = plan.shown;
    } catch (error) {
      const how = `${error.code || error.name}: ${error.message}`;
      if (plan.plain) {
        // Held from before, and shown as it is held: only the record of this
        // invitation was not written, and that is said where a reader looks.
        plan.data.aamio_scope = plan.shown;
        said.push(["scope_share_not_recorded", `message ${entry.seq} shared scope ${plan.shared}, which is held here already as ${plan.held.name}, and the invitation could not be recorded with it in scopes.json: ${how}. The scope stays as it is. Removing it will not remember this invitation, so the same message read again after that would bring the scope back.`]);
        return;
      }
      plan.data.aamio_scope = plan.unsaved;
      said.push(["scope_not_saved", `message ${entry.seq} shared scope ${plan.shared}, and scopes.json could not be written: ${how}. The scope is not kept.`]);
    }
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

  /** A new inbox with the address book as it is now. The old one is kept under another label, and marked muted when it names a key no longer there. */
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

  /**
   * Every older inbox that names a key no longer in the address book is marked
   * muted. It is still read until it expires: what the partners still in the
   * book write there is handed over, and what a removed key writes there is
   * not. Read no more, a partner that had not yet learned the new address
   * wrote where nobody read (a check of 12 November 2026). It is this side's
   * delivery stopping for that key, not a revocation.
   */
  muteGenerations(reason) {
    const partners = new Set(this.partners.map((p) => p.key));
    const muted = [];
    for (const channel of this.state.channels) {
      if (!isObject(channel) || channel.label === "inbox" || channel.muted || !String(channel.label).startsWith("inbox")) continue;
      const gone = (channel.allow || []).filter((key) => key !== "*" && !partners.has(key));
      if (!gone.length) continue;
      channel.muted = true;
      muted.push(channel.w);
      this.note(channel.label, "muted", `inbox ${channel.w} names ${gone.length} key(s) no longer in the address book after ${reason}. They can still write there until ${channel.expire_at}, and what they write is not handed over; what the partners still in the book write there is read until then.`, channel.w);
    }
    return muted;
  }

  /**
   * Whether a message on this channel is signed by a key that has left the
   * address book: on an inbox that named the key, which is read on for the
   * partners still in the book. Judged message by message against the book
   * as it is, so a key taken back in is read again.
   */
  leftTheBook(channel, key) {
    if (!isObject(channel) || typeof key !== "string" || !String(channel.label).startsWith("inbox")) return false;
    const allow = channel.allow || [];
    if (allow.includes("*") || !allow.includes(key)) return false;
    return !this.partners.some((p) => p.key === key);
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
  async send(to, { text = null, data = null, re = null, archivedData = null } = {}) {
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
    Object.assign(body, this.conversation(key, re));
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
    // The archive is a record of the send, not the send. archivedData stands
    // in for data there, for a message that carries what no file should: the
    // archive says which scope was shared and with whom, never its key.
    const stored = answer.status === 201 && isObject(answer.result) ? answer.result : {};
    const archiveError = await this.archiveSafely("sent", {
      kind: "sent", at: this.now(), to: this.nameForKey(entry.to_key) ?? entry.to_key, w: entry.w, status: answer.status, message_id: entry.id, outcome: entry.status,
      seq: stored.seq ?? null, sha256: stored.sha256 ?? null, body: archivedData === null || archivedData === undefined ? body : { ...body, data: archivedData },
    }, `the send ${entry.id}`);
    if (answer.status !== 201) {
      const [retryable, fix] = sendAdvice(outboxOutcome(entry), answer.status);
      // The trace that could not be written is said with the failure too: a
      // command that sends once and exits never fetches attention.
      throw runtimeError("send_failed", `send ${entry.status} (http ${answer.status}): ${JSON.stringify(answer.result)}`, { outcome: entry.status, message_id: entry.id, status: answer.status, outbox_error: answer.outboxError, trace_error: answer.traceError, archive_error: archiveError, retryable, fix });
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
    // The trace that could not be written, beside the delivery it is about.
    if (answer.traceError) sent.trace_error = answer.traceError;
    // And the archive: delivered, and only the record of it here is missing.
    if (archiveError !== null) sent.archive_error = archiveError;
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
    // What an earlier attempt left open stays open, whatever this one is
    // answered: read here, before the status is written over.
    if (outboxOpen(entry)) entry.ever_open = true;
    entry.attempts = (entry.attempts || 0) + 1;
    entry.status = "sending";
    try {
      await this.saveOutbox();
    } catch (error) {
      // Nothing has left this machine for this attempt, and nothing will.
      entry.status = entry.ever_open ? "unknown" : "stopped";
      const why = error.code || error.message;
      if (entry.ever_open) {
        throw runtimeError("retry_not_sent", `the outbox could not be written (${why}), so this attempt of message ${entry.id} was not sent. ${EARLIER_ATTEMPT}`, { message_id: entry.id, outcome: entry.status, retryable: null, fix: "Free the disk, then " + RETRY_SAME_ID });
      }
      throw runtimeError("not_sent", `the outbox could not be written (${why}), so message ${entry.id} was not sent. Free the disk, then send it again.`, { message_id: entry.id, outcome: entry.status });
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
    // After the outcome is saved, and unable to change it.
    const traceError = await this.traceSafely("sent", () => this.traceSent(entry, answer.status, answer.result));
    return { ...answer, notes, outboxError, traceError };
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

  /**
   * What has no settled outcome on this machine: working, in flight, or open
   * after an answer that settles nothing. The question retry asks, so the two
   * never disagree about one entry, an entry an older client wrote included.
   */
  outboxPending() {
    return Object.values(this.outbox).filter((e) => isObject(e) && (["working", "sending"].includes(e.status) || outboxOpen(e)))
      .map((e) => ({ message_id: e.id, to: this.nameForKey(e.to_key) ?? e.to_key, w: e.w, status: e.status, attempts: e.attempts, last_status: e.last_status ?? null, created_at: e.created_at }));
  }

  /**
   * The same stored bytes sent again, for one message or for every one worth
   * sending again: one that left and got no answer that settles it, or one a
   * rate window or a busy service turned away. The id, the address, the key
   * and the envelope are the ones stored, so a recipient that keeps what it
   * has seen marks a second copy as a replay. A delivery, and a refusal the
   * service will repeat, are not sent again: nothing goes out for them.
   * Whether the action behind the message is safe to repeat is the
   * application's agreement with the other side, not this function's.
   */
  async outboxRetry(id = null) {
    const out = [];
    for (const entry of Object.values(this.outbox)) {
      if (!isObject(entry) || (id !== null && entry.id !== id) || !outboxRetryable(entry)) continue;
      let answer;
      try {
        answer = await this.deliver(entry, await this.client.planFor(entry.w));
      } catch (error) {
        if (error instanceof Error) {
          // What was sent again before this one stopped is said with the stop.
          error.retried = out;
          // A stop at the gate says nothing was sent, which is true of this
          // attempt and not of the message: which message, and what an earlier
          // attempt left open, are said beside the gate's own words.
          if (error instanceof GateStop) {
            Object.assign(error, { message_id: entry.id, outcome: outboxOutcome(entry) });
            if (outboxOpen(entry)) error.earlier_attempt = `This stop is about this attempt only. ${EARLIER_ATTEMPT} When the gate can be met, ${RETRY_SAME_ID}`;
          }
        }
        throw error;
      }
      const row = { id: entry.id, w: entry.w, status: entry.status, http: answer.status };
      if (answer.outboxError) {
        // What the service answered stands. Only the record of it on this
        // machine failed, and the answer says both.
        row.outbox_error = answer.outboxError;
        row.note = answer.status === 201
          ? "Delivered: aamio stored it. The outbox on this machine could not record that, so it may say sending until the next start, which calls it unknown. Do not send this message again."
          : "The outbox on this machine could not record this answer, so the entry may say sending until the next start, which calls it unknown.";
      }
      if (answer.traceError) row.trace_error = answer.traceError;
      out.push(row);
    }
    return out;
  }

  /**
   * One entry dropped once its fate no longer matters. Nothing is retried
   * after this. A send that is already away cannot be recalled, and the answer
   * says so rather than reporting a clean stop: the difference decides whether
   * the caller may compose a replacement. The entry is gone from this runtime
   * only when it is gone from outbox.json.
   */
  async outboxForget(id) {
    const held = Object.hasOwn(this.outbox, id) && isObject(this.outbox[id]) ? this.outbox[id] : null;
    const outcome = outboxOutcome(held);
    if (held !== null) {
      delete this.outbox[id];
      try {
        await this.saveOutbox();
      } catch (error) {
        this.outbox[id] = held;
        throw runtimeError("not_saved", `the outbox could not be written (${error.code || error.message}), so message ${id} is still in it and nothing was dropped. Free the disk, then forget it again.`, { message_id: id, outcome });
      }
      this.untold.delete(id);
    }
    return { id, forgotten: held !== null, already_sending: !["never_sent", "not_found"].includes(outcome), outcome, note: OUTBOX_NOTES[outcome] };
  }

  // ------------------------------------------------------------- trace --
  //
  // A conversation that goes wrong is hard to take apart from one side. The
  // trace is what this side can show: for each counterpart, what was sent and
  // how the service answered, what arrived and whether it opened, as hashes and
  // shapes and never content. It is diagnostics: whatever goes wrong in it
  // costs the trace, never the send or the read it records.

  /** A trace that did not happen, said in attention, where a caller looks. The line is given back for the answer it belongs to. */
  untraced(line) {
    this.note("trace", "untraced", line + " The sends and reads themselves are unaffected; what is behind is the record of them.");
    return line;
  }

  /** update run, and whatever goes wrong in it said as a trace that did not happen. Gives back the line that says so, or null. */
  async traceSafely(what, update) {
    try {
      return (await update()) ?? null;
    } catch (error) {
      return this.untraced(`trace ${what}: not recorded: ${error?.name || "Error"}: ${error?.message}`);
    }
  }

  /** The record for one key, made when first needed and kept to a bound. */
  traceBook(key) {
    let book = this.traces[key];
    if (!isObject(book)) book = this.traces[key] = { sent: [], received: [], last_read: null, active: 0 };
    book.active = Math.floor(this.now());
    const keys = Object.keys(this.traces);
    if (keys.length > TRACE_KEYS) {
      const stale = keys.sort((a, b) => (this.traces[a]?.active || 0) - (this.traces[b]?.active || 0)).slice(0, keys.length - TRACE_KEYS);
      for (const old of stale) if (old !== key) delete this.traces[old];
    }
    return book;
  }

  /**
   * The two fields a message carries about the conversation it is part of: re,
   * the message it answers, and seen, the last message from this key that was
   * read here and could be opened. A trace that cannot say leaves seen out,
   * and never stops a send.
   */
  conversation(key, re = null) {
    const fields = {};
    if (re) fields.re = re;
    const last = isObject(this.traces[key]) ? this.traces[key].last_read : null;
    if (isObject(last) && isMessageHash(last.sha256)) fields.seen = last.sha256;
    return fields;
  }

  /** One answer to one send: what went where, as the service stored it. Once per message id: a retry replaces the row. */
  async traceSent(entry, status, result) {
    const key = entry.to_key;
    if (!key) return null;
    const stored = status === 201 && isObject(result);
    const record = traceRow({
      message_id: entry.id, at: Math.floor(this.now()), w: entry.w, status, outcome: entry.status,
      seq: stored ? result.seq ?? null : null, sha256: stored ? result.sha256 ?? null : null, sealed: true,
      ...(isObject(entry.shape) ? entry.shape : {}),
    }, TRACE_SENT_FIELDS);
    const book = this.traceBook(key);
    book.sent = [...book.sent.filter((row) => row.message_id !== record.message_id), record].slice(-TRACE_KEEP);
    return this.saveTrace();
  }

  /**
   * One verified message from a key, as it arrived here. Recorded whether or
   * not it could be opened, since one that could not is what a trace is for.
   * Taken as read only when it could: last_read is what the next message to
   * this key names as seen, and it names a message this side opened, not one
   * that merely arrived. A replay is neither recorded nor read: its first
   * arrival was, and an old message sent again must not move seen back to it.
   * Whether anything changed.
   */
  traceReceived(channel, entry) {
    if (entry.replay) return false;
    const opened = (entry.format === "text" || entry.format === "json") && !entry.error;
    const body = opened && isObject(entry.body) ? entry.body : {};
    const row = traceRow({
      at: entry.at, channel: channel.label, w: channel.w, seq: entry.seq, sha256: entry.sha256, encrypted: entry.encrypted, format: entry.format,
      error: entry.error,
      // What a message held is known only if it opened.
      fields: opened ? Object.keys(body).sort() : null,
      text_chars: typeof body.text === "string" ? [...body.text].length : null,
      re: body.re, seen: body.seen,
    }, TRACE_RECEIVED_FIELDS);
    const book = this.traceBook(entry.from_key);
    if (row.sha256 && book.received.some((held) => held.sha256 === row.sha256)) return false;
    book.received = [...book.received, row].slice(-TRACE_KEEP);
    if (opened && entry.verified === true && isMessageHash(entry.sha256)) {
      book.last_read = traceRow({ sha256: entry.sha256, seq: entry.seq, w: channel.w, at: entry.at }, TRACE_READ_FIELDS);
    }
    return true;
  }

  /** What a read handed over, recorded once the read is written down: a message that was not handed over was not read. */
  async traceRead(channel, entries) {
    await this.traceSafely("received", async () => {
      let changed = false;
      for (const entry of entries) {
        if (entry.verified === true && entry.from_key) changed = this.traceReceived(channel, entry) || changed;
      }
      return changed ? this.saveTrace() : null;
    });
  }

  /** A partner name, a key or a write address, as the key it stands for, or null. */
  traceKey(who) {
    const partner = typeof who === "string" ? this.partnerByName(who) : null;
    if (partner) return partner.key;
    if (isKey(String(who))) return String(who);
    return typeof who === "string" && Object.hasOwn(this.state.peers, who) ? this.state.peers[who] : null;
  }

  /**
   * What was sent to one counterpart and what came back, as hashes and shapes.
   * who is a partner name, a key or a write address; without it, one line per
   * counterpart. Nothing here is content: the sha256 is what the service
   * stored, byte for byte, so the other side can hold its own trace against
   * this one.
   */
  trace(who = null, limit = 20) {
    const most = Math.max(1, Math.min(Math.floor(Number(limit) || 20), TRACE_KEEP));
    if (who === null || who === undefined) {
      const everyone = [];
      for (const [key, book] of Object.entries(this.traces)) {
        if (!isObject(book)) continue;
        const sent = Array.isArray(book.sent) ? book.sent : [];
        const received = Array.isArray(book.received) ? book.received : [];
        everyone.push({
          with: this.nameForKey(key) ?? key, key, sent: sent.length, received: received.length,
          last_sent_at: sent.length ? sent[sent.length - 1].at ?? null : null,
          last_received_at: received.length ? received[received.length - 1].at ?? null : null,
          no_read_claim: traceView(book, TRACE_KEEP).no_read_claim.length,
        });
      }
      const latest = (row) => Math.max(row.last_sent_at || 0, row.last_received_at || 0);
      everyone.sort((a, b) => latest(b) - latest(a));
      return { counterparts: everyone, note: "Name one with who for the messages themselves, as hashes." };
    }
    const key = this.traceKey(who);
    const book = key && Object.hasOwn(this.traces, key) ? this.traces[key] : null;
    if (!isObject(book)) throw runtimeError("no_trace", `nothing sent to or received from ${who} is recorded here`);
    const view = traceView(book, most);
    return {
      with: this.nameForKey(key) ?? key, key, sent: view.sent, received: view.received,
      // What this side last read and opened from them: what the next message to them names as seen.
      last_read: book.last_read ?? null,
      no_read_claim: view.no_read_claim, note: view.note,
    };
  }

  // ---------------------------------------------------------- channels --
  //
  // A channel is a thread of its own beside the inbox: its own lifetime, its
  // own list of who may write, and with a gate its own conditions. Its
  // address reaches whoever is to write there in a sealed and signed message,
  // which is what lets their runtime send to it: an address pasted into text
  // binds nothing.

  /** The channel a label names, apart from upper and lower case: two labels that differ only so are one file in the archive where the file system says so. */
  channelCalled(label) {
    const wanted = String(label).toLowerCase();
    return this.state.channels.find((channel) => isObject(channel) && String(channel.label).toLowerCase() === wanted) ?? null;
  }

  /**
   * A thread opened for these keys and held as a channel under this label,
   * used only once state.json holds it. One that cannot be written down is
   * closed again at the service, as far as that can be done, and its address
   * is given to nobody: after a restart this home could not read there.
   */
  async openChannelThread(label, keys, ttl, gate = null) {
    let thread;
    try {
      thread = await this.client.open({ ttl, allow: keys.length ? keys : undefined, gate: gate ?? undefined });
    } catch (error) {
      const said = isObject(error.body) ? error.body : {};
      const status = Number.isInteger(error.status) ? error.status : 0;
      // Only a refusal says nothing was opened. With no answer, or one that
      // does not say, the service may hold a thread: its read key was made for
      // this request and is kept nowhere, so nobody reads there, nobody was
      // given its address, and it goes when its time is out. "Nothing was
      // opened" was said of a thread the service held (a check of 12 November
      // 2026).
      const refused = status >= 400 && status < 500;
      const after = refused
        ? "Nothing was opened."
        : `${status === 0 ? "No answer came back, so it is not known" : "That answer does not say"} whether the service opened a thread. This home holds no channel called ${label}, and nobody was given an address: a thread opened there is read by nobody and goes when its time is out.`;
      const fix = said.fix ?? (refused ? null : "Opening it again is safe: that makes a new address, and the one that may be there is known to nobody.");
      throw runtimeError("channel_unavailable", `could not open channel: ${status} ${said.error ?? JSON.stringify(error.body ?? error.message)}. ${after}`, { status, ...(fix ? { fix } : {}) });
    }
    const channel = { label, read_key: thread.id, w: thread.w, expire_at: thread.expireAt, allow: keys, after: 0, created_at: null, instance: null, gone: false, muted: false, seen: [], seen_from: [] };
    this.state.channels.push(channel);
    try {
      await this.saveState();
    } catch (error) {
      this.state.channels = this.state.channels.filter((held) => held !== channel);
      const closed = await this.client.close({ w: thread.w, id: thread.id }).then(() => true, () => false);
      throw runtimeError("not_saved", `the channel could not be written down (${error.code || error.message}), so it is not used and its address was given to nobody. ${closed ? "It was closed again at the service." : `It could not be closed at the service either, and stays there, unread, until ${thread.expireAt}.`}`);
    }
    return channel;
  }

  /**
   * A channel with its own lifetime and, with to, its address handed to
   * whoever is to write there. to is a partner's name or key, or a write
   * address a verified message gave as reply_to or channel. That key goes on
   * the list beside the partners in allow, and the address goes to it sealed
   * and signed. Where the address goes, whose key seals it, whether the inbox
   * there takes it and whether the message fits are settled before anything
   * is opened: what stops there leaves no channel behind.
   */
  async channelOpen(label, { ttl = CHANNEL_TTL, allow = null, gate = null, to = null, note = null } = {}) {
    checkLabel(label);
    checkChannelTtl(ttl);
    if (this.channelCalled(label) !== null) throw runtimeError("channel_exists", `there is a channel called ${this.channelCalled(label).label} already. Close it or choose another label`);
    const handing = to !== null && to !== undefined;
    if (note !== null && note !== undefined && !handing) throw runtimeError("invalid_note", "note travels with the address to whoever to names, so without to there is nothing to carry it");
    const keys = [];
    for (const name of allow ?? []) {
      const partner = this.partnerByName(name);
      if (partner === null) throw runtimeError("unknown_partner", `unknown partner: ${name}`);
      if (!keys.includes(partner.key)) keys.push(partner.key);
    }
    if (gate !== null && gate !== undefined) checkGate(gate);
    let handover = null;
    if (handing) {
      const { w: replyTo, key } = await this.recipient(to);
      // The gate of the inbox the address goes to, read as a send reads it.
      const advice = await this.client.planFor(replyTo);
      this.handoverFits(key, ttl, note);
      if (!keys.includes(key)) keys.push(key);
      handover = { replyTo, key, advice };
    }
    const channel = await this.openChannelThread(label, keys, ttl, gate ?? null);
    // The gate is in the answer whether or not there is one. It is not kept
    // here: the thread holds it and GET /{w}/gate serves it, and a second copy
    // on this machine could only disagree with the first.
    const opened = { label, w: channel.w, expire_at: channel.expire_at, allow: keys.map((key) => this.nameForKey(key) ?? key), gate: gate ?? null };
    if (handover === null) return opened;
    const told = await this.handOver(channel, handover.key, handover.replyTo, note, handover.advice);
    return { ...opened, handed_to: this.nameForKey(handover.key) ?? handover.key, address_sent_to: handover.replyTo, ...told };
  }

  /**
   * A private channel only that key may write to, with its address handed
   * over when replyTo says where. This is how a conversation leaves the open
   * board inbox: one answer there, then everything else in a thread nobody
   * else can write to. key is a key, or a partner's name.
   */
  async channelOpenWith(key, { ttl = 900, label = null, replyTo = null, note = null } = {}) {
    checkChannelTtl(ttl);
    let theirs = String(key);
    if (!isKey(theirs)) {
      const partner = this.partnerByName(theirs);
      if (partner === null) throw runtimeError("unknown_partner", `not a key and not a known partner: ${key}`);
      theirs = partner.key;
    }
    const handing = replyTo !== null && replyTo !== undefined;
    if (handing && !(typeof replyTo === "string" && ADDRESS.test(replyTo))) throw runtimeError("invalid_address", "reply-to is a write address, 20 characters of a-z and 2-7, as a verified message gives it in reply_to");
    if (note !== null && note !== undefined && !handing) throw runtimeError("invalid_note", "note travels with the address to the inbox reply-to names, so without reply-to there is nothing to carry it");
    // An address this home knows as another key's is not the place to send this one's channel.
    const bound = handing ? this.state.peers[replyTo] : undefined;
    if (bound !== undefined && bound !== theirs) {
      throw runtimeError("binding_conflict", `the address ${replyTo} is bound to ${this.nameForKey(bound) ?? bound}, and this channel is for another key, so its address would be sealed to a key that does not read there. Nothing was opened.`);
    }
    let name = label;
    if (name !== null && name !== undefined) {
      checkLabel(name);
      if (this.channelCalled(name) !== null) throw runtimeError("channel_exists", `there is a channel called ${this.channelCalled(name).label} already. Close it or choose another label`);
    } else {
      name = `with-${keyHash(theirs).slice(0, 8)}`;
      if (this.channelCalled(name) !== null) name = this.freeLabel(`${name}-${Math.floor(this.now())}`);
    }
    let advice = null;
    if (handing) {
      advice = await this.client.planFor(replyTo);
      this.handoverFits(theirs, ttl, note);
    }
    const channel = await this.openChannelThread(name, [theirs], ttl);
    const opened = { label: name, w: channel.w, expire_at: channel.expire_at, with: this.nameForKey(theirs) ?? theirs, address_sent_to: handing ? replyTo : null };
    if (!handing) return opened;
    return { ...opened, ...(await this.handOver(channel, theirs, replyTo, note, advice)) };
  }

  /** The body that carries a channel's address, and the envelope it is sealed in. */
  invitation(key, w, expireAt, note = null) {
    const body = { channel: w, expire_at: expireAt };
    if (note !== null && note !== undefined && note !== "") body.text = String(note);
    Object.assign(body, this.conversation(key));
    return [body, this.keys.seal(key, JSON.stringify(body))];
  }

  /**
   * Whether the message that will carry a channel's address fits in one
   * message, asked before the channel is opened. The address and the expiry
   * are not known yet. Both have a fixed length, so a stand-in of the same
   * length seals to the same size. A note too long for it would open the
   * channel first, and the message carrying the address would then be refused.
   */
  handoverFits(key, ttl, note = null) {
    const [body] = this.invitation(key, "a".repeat(20), Math.floor(this.now()) + ttl, note);
    // seen can appear before the handover, if a message from this key is read
    // meanwhile, and it is always 64 characters: counted as there already.
    if (!("seen" in body)) body.seen = "0".repeat(64);
    const size = Buffer.byteLength(this.keys.seal(key, JSON.stringify(body)), "utf8");
    if (size > MESSAGE_MAX_BYTES) {
      throw runtimeError("too_large", `with this note the message carrying the address would be ${size} bytes, and a message is at most ${MESSAGE_MAX_BYTES}, so no channel was opened. Shorten the note, and send the rest on the channel once it is open.`);
    }
  }

  /**
   * The channel's address sent to replyTo, sealed to key and signed, through
   * the outbox like any send, so its outcome is kept and the same bytes can
   * go again. Gives what the caller's answer carries besides: the message's
   * id, and what could not be recorded of it here.
   *
   * Whatever stops it, the channel is open by now, and the failure says so,
   * with the channel, and says whether anything left this machine and, of
   * what left, whether it is known not to have arrived.
   */
  async handOver(channel, key, replyTo, note = null, advice = null) {
    const opened = { label: channel.label, w: channel.w, expire_at: channel.expire_at };
    const listed = `The channel ${channel.label} is open and listed by channel list, aamio_channels over MCP`;
    // Said of a message the service turned away or a gate stopped: it is known not to be there.
    const still = `${listed}: only the message carrying its address did not go. `;
    // Said of one that left and has no answer that settles it. It may be with
    // them already, and "did not go" read as leave to open another channel and
    // invite again, which the one who has the first reads as two (a check of
    // 12 November 2026).
    const unsettled = `${listed}, and the message carrying its address may have arrived: its outcome is not known. Do not open another channel for this: a new attempt is the same message, under the same message_id. `;
    let entry = null;
    let answer;
    try {
      const [body, envelope] = this.invitation(key, channel.w, channel.expire_at, note);
      entry = await this.outboxAdd(replyTo, key, envelope, body);
      answer = await this.deliver(entry, advice ?? await this.client.planFor(replyTo));
    } catch (error) {
      if (error instanceof GateStop) {
        error.opened = opened;
        // Nothing was sent, so nobody has the address, and the channel is one
        // nobody will write to: closed, and opened anew when it can be handed over.
        error.fix = still + `Nothing was sent, so nobody has been given its address: close it with channel close ${channel.label}, aamio_close_channel over MCP, and open a new one when the inbox's conditions can be met. ` + (error.fix ?? "");
        throw error;
      }
      // Stopped before a byte left: the outbox could not be written, or the message could not be made.
      throw runtimeError("send_failed", `the channel ${channel.label} is open, and the message carrying its address was not sent: ${error.message}`, {
        outcome: "never_sent", message_id: entry?.id ?? error.message_id ?? null, status: 0, opened, retryable: false,
        fix: `Nothing left this machine, so nobody has been given the address of ${channel.label}. Close it with channel close ${channel.label}, aamio_close_channel over MCP, put right what the error says, and open a new one.`,
      });
    }
    if (answer.status !== 201) {
      const outcome = outboxOutcome(entry);
      const [retryable, advice] = sendAdvice(outcome, answer.status);
      // Only a refusal says the message is not there.
      const refused = outcome === "refused";
      // And then nobody has the address. Sending a corrected message, as a
      // refused send is told, would need the address, and an address goes
      // only with a channel: this one is closed, and a new one opened.
      const fix = refused && !SEND_TRY_LATER.includes(answer.status)
        ? `aamio refused it, so nobody has been given the address of ${channel.label}. Close it with channel close ${channel.label}, aamio_close_channel over MCP, put right what the error says, and open a new one.`
        : advice;
      throw runtimeError("send_failed", `the channel ${channel.label} is open, and the message carrying its address ${refused ? "did not land" : "may have arrived"}: send ${entry.status} (http ${answer.status}): ${JSON.stringify(answer.result)}`, {
        outcome: entry.status, message_id: entry.id, status: answer.status, outbox_error: answer.outboxError, trace_error: answer.traceError, opened, retryable, fix: (refused ? still : unsettled) + fix,
      });
    }
    const told = { message_id: entry.id };
    if (answer.notes?.length) told.notes = answer.notes;
    if (answer.outboxError) {
      told.outbox_error = answer.outboxError;
      told.note = "Delivered: aamio stored the message carrying the address. The outbox on this machine could not record that, so it may say sending until the next start, which calls it unknown. Do not hand the address over again.";
    }
    if (answer.traceError) told.trace_error = answer.traceError;
    return told;
  }

  /** The channels of this home: the public address, how long each has left, and how far it is read. Never a read key. */
  channelList() {
    const now = this.now();
    return this.state.channels.filter(isObject).map((channel) => ({
      label: channel.label, w: channel.w, expire_at: channel.expire_at, seconds_left: Math.max(0, Math.floor(Number(channel.expire_at) - now)), expired: Number(channel.expire_at) <= now,
      allow: (channel.allow || []).map((key) => this.nameForKey(key) ?? key),
      // What this process read here, and where the cursor stands: what a command of its own, which has read nothing, can still say.
      received: (this.received.get(channel.w) ?? []).length, read_to: Number.isInteger(channel.after) ? channel.after : 0, gone: channel.gone === true, muted: channel.muted === true,
    }));
  }

  /**
   * Closes a channel before it expires. The thread is asked gone at the
   * service first, and the channel leaves this home when the service says it
   * is gone: deleted now, or not there any more. When the service does not
   * say so, the channel stays and is still read: taken out of this home while
   * the thread lived on, whoever wrote there would write where nobody reads.
   * The answer says which of the two happened, here and at the service.
   */
  async channelClose(label) {
    const channel = this.channel(String(label));
    if (!isObject(channel)) {
      const labels = this.state.channels.filter(isObject).map((held) => held.label);
      throw runtimeError("unknown_channel", `no channel called ${label} in this home. It has ${labels.length ? labels.join(", ") : "none"}.`);
    }
    let status = 200;
    try {
      await this.client.close({ w: channel.w, id: channel.read_key });
    } catch (error) {
      status = error instanceof AamioError ? error.status : 0;
    }
    const gone = status === 200 || status === 404 || status === 410;
    if (!gone) {
      return {
        label: channel.label, w: channel.w, status, deleted: false, closed_here: false,
        note: `${status === 0 ? "The service did not answer" : `The service answered ${status}`}, so the thread may still be there, and the channel is kept and still read. Close it again, or let it expire at ${channel.expire_at}.`,
      };
    }
    const before = this.state.channels;
    this.state.channels = before.filter((held) => held !== channel);
    try {
      await this.saveState();
    } catch (error) {
      this.state.channels = before;
      throw runtimeError("not_saved", `${status === 200 ? "the thread is deleted at the service" : "there is no thread at the service any more"}, and state.json could not be written (${error.code || error.message}), so this home still lists ${channel.label}. Close it again once the disk takes writes.`, { status, deleted: status === 200 });
    }
    this.received.delete(channel.w);
    this.observed.delete(channel.w);
    return {
      label: channel.label, w: channel.w, status, deleted: status === 200, closed_here: true,
      ...(status === 200 ? {} : { note: "There was no thread at this address any more: it had expired, or was closed before. The channel is taken out of this home." }),
    };
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

  /**
   * A need or an offer on the open board, pointing at the board inbox, which
   * outlives it. With scope, the name of a scope held here, the post carries
   * that scope's address and is unlisted: only a find with the scope's key
   * returns it. Unlisted is not private.
   */
  async boardPost({ kind, title, text, tags = [], ttl = BOARD_TTL, lang = null, deadline = null, scope = null } = {}) {
    // Before the inbox is opened, so a name that is not here costs nothing.
    const held = scope !== null && scope !== undefined ? this.scopeNamed(scope) : null;
    const life = Math.floor(Number(ttl) || BOARD_TTL);
    // An inbox that outlives the post by the margin the library leaves for the work and the round trip.
    const channel = await this.ensureBoardInbox(life + BOARD_POST_MARGIN);
    let made;
    try {
      // The address goes inside the signed body, so nobody can post the same bytes without it.
      made = await this.client.board.post({ kind, title, text, tags: (tags || []).slice(0, 8), ttl: life, ...(lang ? { lang } : {}), ...(deadline ? { deadline } : {}), ...(held ? { scope: held.address } : {}) }, { inbox: { w: channel.w, expireAt: channel.expire_at } });
    } catch (error) {
      throw boardError("board post", error);
    }
    // The post is made. A record of it that cannot be written is said beside
    // it, and is no reason to tell the caller the post failed: it would be
    // made again.
    const archiveError = await this.archiveSafely("board", { kind: "posted", at: this.now(), post: made.post }, `the post ${isObject(made.post) ? made.post.id : ""}`);
    // Where the answers go, until when that inbox is open and how to read
    // them, in the answer itself. The inbox's time is not the post's:
    // post.expire_at is when the post leaves the board.
    return {
      post: made.post, inbox: channel.w, inbox_expires_at: channel.expire_at, answers_arrive_on: "board",
      read_them_with: "Read them with read, aamio read on the command line and aamio_read over MCP, which shows every message on your inboxes, the board inbox among them. board replies on the command line lists only the answers, the messages that name a post of yours or arrived on a board inbox, and says how many it left out.",
      ...(held ? { scope: held.name } : {}),
      ...(archiveError !== null ? { archive_error: archiveError } : {}),
    };
  }

  /**
   * Live posts that match: kind, tags (a tag covers its dotted children), lang,
   * after (the cursor from the last page), wait (up to 25 s for the next one)
   * and min_work_bits. The address on each post is bound to its key, so a send
   * to it is sealed to the poster. An address bound before keeps its key.
   *
   * With scope, the name of a scope held here with its key, the find reads
   * that scope instead of the public board. The key goes to the board in the
   * body of the find and nowhere else, and is in nothing this gives back.
   */
  async boardFind({ kind = null, tags = null, lang = null, after = 0, wait = 0, min_work_bits: bits = 0, scope = null } = {}) {
    const held = scope !== null && scope !== undefined ? this.scopeNamed(scope) : null;
    if (held !== null && !held.key) throw runtimeError("scope_write_only", `scope ${held.name} is held to post only. Reading it takes the key, which a partner can share with access read`);
    const filter = { after: Math.max(0, Math.floor(Number(after) || 0)) };
    if (kind) filter.kind = kind;
    if (tags?.length) filter.tags = tags.slice(0, 20);
    if (lang) filter.lang = lang;
    if (wait) filter.wait = Math.min(25, Math.floor(wait));
    if (bits) filter.min_work_bits = Math.floor(bits);
    const unread = () => runtimeError("board_failed", `the board did not say it read scope ${held.name}, so these posts are not shown`);
    let page;
    try {
      // A board older than scopes answers 400 to the field, so it never reads the public board instead.
      page = await this.client.board.find(held ? { ...filter, scopeKey: held.key } : filter);
    } catch (error) {
      // The client believes only an answer that names the scope, and says so as an answer of 200 that is not one.
      if (held && error instanceof AamioError && error.status === 200) throw unread();
      const failure = boardError("board find", error);
      if (held) {
        failure.message = withoutScopeKey(failure.message, held.key);
        if (failure.fix) failure.fix = withoutScopeKey(String(failure.fix), held.key);
      }
      throw failure;
    }
    if (!isObject(page) || !Array.isArray(page.posts)) throw runtimeError("board_failed", "the board answered the find with something that is not a page of posts");
    if (held) {
      // The answer names the scope it read. Without that it did not read this one.
      if (page.scope !== held.address) throw unread();
      page = withoutScopeKey(page, held.key);
      page.scope_name = held.name;
    }
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
    let done;
    try {
      done = await this.client.board.withdraw(String(id));
    } catch (error) {
      throw boardError("withdraw", error);
    }
    const archiveError = await this.archiveSafely("board", { kind: "withdrawn", at: this.now(), id: String(id) }, `the withdrawal of post ${id}`);
    return archiveError !== null && isObject(done) ? { ...done, archive_error: archiveError } : done;
  }

  /**
   * An answer to a post: sealed to the poster's key, signed by this one, with
   * the post id and the board inbox to write back to. It goes the way a send
   * goes, written to the outbox first, so its outcome is kept and a silence is
   * unknown rather than failed. The board inbox outlives the post by
   * ANSWER_MARGIN, so the poster can answer back after reading it late.
   */
  async boardAnswer(postId, { text = null, data = null, scope = null } = {}) {
    const scoped = scope !== null && scope !== undefined;
    // A post in a scope is never served by id alone, so with scope the post is looked up in that scope.
    const post = scoped ? await this.scopedPost(scope, postId) : await this.boardGet(postId);
    if (post === null) {
      throw runtimeError("unknown_post", scoped
        ? `no live post with id ${postId} in scope ${scope}: it expired or was withdrawn, or it is in another scope.`
        : `no live post with id ${postId}: it expired or was withdrawn. A post in a scope is found with the scope's name: board answer --scope NAME, or scope over MCP.`);
    }
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
    Object.assign(body, this.conversation(post.key));
    const entry = await this.outboxAdd(post.w, post.key, this.keys.seal(post.key, JSON.stringify(body)), body);
    const answer = await this.deliver(entry, advice);
    const archiveError = await this.archiveSafely("board", { kind: "answered", at: this.now(), post: post.id, w: post.w, status: answer.status, message_id: entry.id, outcome: entry.status, body }, `the answer ${entry.id}`);
    if (answer.status !== 201) {
      const [retryable, fix] = sendAdvice(outboxOutcome(entry), answer.status);
      throw runtimeError("send_failed", `answer ${entry.status} (http ${answer.status}): ${JSON.stringify(answer.result)}`, { outcome: entry.status, message_id: entry.id, status: answer.status, outbox_error: answer.outboxError, trace_error: answer.traceError, archive_error: archiveError, retryable, fix });
    }
    const receipt = isObject(answer.result) ? answer.result : {};
    const done = { post: post.id, w: post.w, message_id: entry.id, seq: receipt.seq ?? null, at: receipt.at ?? null, sha256: receipt.sha256 ?? null, replies_arrive_on: "board", reply_to: channel.w };
    if (answer.notes?.length) done.notes = answer.notes;
    if (answer.outboxError) {
      done.outbox_error = answer.outboxError;
      done.note = "Delivered: aamio stored it. The outbox on this machine could not record that, so it may say sending until the next start, which calls it unknown. Do not answer again.";
    }
    if (post.key === this.keys.public) done.warning = "You answered your own post. The answer is sealed to your own key, so it reaches nobody but you.";
    if (answer.traceError) done.trace_error = answer.traceError;
    if (archiveError !== null) done.archive_error = archiveError;
    return done;
  }

  /**
   * Reads the board inboxes, and only those: the one posts point at now and
   * the older ones still open. What waits on the other channels is left where
   * it is, for read, and the inbox's cursor stands. With wait, the newest
   * board inbox is waited on, and the others are asked once.
   */
  async boardPoll(wait = 0) {
    this.dropExpired();
    const now = this.now();
    const boards = this.state.channels.filter((channel) => isObject(channel) && (channel.label === "board" || String(channel.label).startsWith("board-")) && !channel.muted && Number(channel.expire_at) > now)
      .sort((a, b) => (a.label === "board" ? -1 : b.label === "board" ? 1 : 0));
    const collected = [];
    for (const [index, channel] of boards.entries()) collected.push(...(await this.poll(channel, index === 0 ? Math.min(25, Math.max(0, wait)) : 0, null, null)));
    return collected;
  }

  /**
   * Answers to this home's posts, decrypted and verified, oldest first: what
   * this process read, and what the archive holds from before. A command is a
   * process of its own, so without the archive a run would show only what
   * arrived inside its own wait, though the rest was read and written down.
   * With postId, the answers that name that post, wherever they arrived.
   * Without it, everything that arrived on a board inbox and everything that
   * names a post. How many messages were left out is kept in
   * boardRepliesLeftOut.
   *
   * One delivery is one row. A row with its thread's instance is one
   * delivery by its address, instance and seq, and the first of its copies
   * stands, as it was first handed over: the one the archive has from before,
   * when it has one this process did not write. Any other row is told by all
   * it shows, and two such rows that show the same are both kept: nothing
   * says they are one. The rule is aamio-python's, row for row.
   */
  async boardReplies(postId = null) {
    const one = (entry) => (typeof entry.instance === "string" ? [entry.w, entry.instance, entry.seq].join("\u0000") : null);
    const shown = (entry) => JSON.stringify([entry.w ?? null, entry.seq ?? null, entry.at ?? null, entry.sha256 ?? null, entry.from_key ?? null]);
    const wanted = (entry) => {
      const body = entry.body;
      if (postId !== null && postId !== undefined) return isObject(body) && body.post === postId;
      // An answer names the post it answers, and most do. One that does not is
      // still an answer if it arrived on the address a post gave out.
      if (String(entry.channel ?? "").startsWith("board")) return true;
      return isObject(body) && typeof body.post === "string";
    };
    const count = (keys) => {
      const counted = new Map();
      for (const key of keys) if (key !== null) counted.set(key, (counted.get(key) ?? 0) + 1);
      return counted;
    };
    // Every channel, not only the ones named board: an answer can arrive on a
    // private channel opened for the conversation.
    const held = [];
    for (const channel of this.state.channels) if (isObject(channel)) held.push(...(this.received.get(channel.w) ?? []));
    // And every file of the archive: a board inbox is renewed while the old
    // one still holds answers, and the old one keeps its own label and its own
    // file after its channel has left this home. What an earlier run wrote is
    // read whether the archive is on or off now: it stays the record of what
    // arrived until it is pruned.
    const rows = [];
    let names = [];
    try {
      names = await archiveNames(this.home);
    } catch (error) {
      this.note("archive", "unread", `the archive could not be listed (${error.code || error.name}), so answers written down earlier are not in this result`);
    }
    for (const name of names) {
      try {
        rows.push(...(await archivedRecords(this.home, name, "received")));
      } catch (error) {
        this.note("archive", "unread", `the archive ${name}.jsonl could not be read (${error.code || error.name}), so answers written down earlier are not in this result`);
      }
    }
    // A delivery the archive has more rows of than this process wrote was
    // written down before this process read it: that row is its first copy,
    // and the copies held here are later readings of it.
    const stored = count(rows.map(one));
    const written = count(held.filter((entry) => entry.archived !== false).map(one));
    const earlier = new Set([...stored].filter(([delivery, rowsOfIt]) => rowsOfIt > (written.get(delivery) ?? 0)).map(([delivery]) => delivery));
    const out = [];
    const skipped = [];
    const named = new Set();
    for (const entry of held) {
      const delivery = one(entry);
      if (delivery !== null) {
        if (named.has(delivery) || earlier.has(delivery)) continue;
        named.add(delivery);
      }
      (wanted(entry) ? out : skipped).push(entry);
    }
    // A copy in memory without the instance, from a service that names none,
    // has its row in the archive as well when it was written down, and stands
    // for one row there that shows the same. One that was not written down
    // has no row there and stands for none.
    const onDisk = count(held.filter((entry) => one(entry) === null && entry.archived !== false).map(shown));
    for (const entry of rows) {
      const delivery = one(entry);
      if (delivery !== null) {
        if (named.has(delivery)) continue;
        named.add(delivery);
      } else if ((onDisk.get(shown(entry)) ?? 0) > 0) {
        onDisk.set(shown(entry), onDisk.get(shown(entry)) - 1);
        continue;
      }
      if (wanted(entry)) out.push({ ...entry, from_archive: true });
      else skipped.push(entry);
    }
    out.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0) || (Number(a.seq) || 0) - (Number(b.seq) || 0));
    this.boardRepliesLeftOut = skipped.length;
    // An empty list is easily read as an empty inbox, and the reader goes
    // looking for the fault at the other end. Whatever this passed over is
    // still a message, so it says how many there are and where.
    if (skipped.length && !out.length) {
      const unopened = skipped.filter((entry) => !entry.verified).length;
      const unread = unopened ? `, and ${unopened} of them arrived unsigned, so the body was never opened` : "";
      this.note("board replies", "filtered", postId !== null && postId !== undefined
        ? `Nothing here answers post ${postId}, but ${skipped.length} other message(s) are on your channels${unread}. Run board replies without a post, or read, to see them.`
        : `${skipped.length} message(s) are here and none of them looks like a board answer, because they name no post and did not arrive on a board inbox${unread}. Run read to see them.`);
    }
    return out;
  }

  /**
   * Where answers to this home's posts and answers arrive, and whether it is
   * still open. A board inbox that has expired is the difference between
   * nobody replied and nobody could.
   */
  boardReplyAddress() {
    const channel = this.channel("board");
    if (channel === null) return { w: null, open: false, why: "No board inbox on this machine. One is opened when you answer or post." };
    const left = Math.floor(Number(channel.expire_at) - this.now());
    if (left > 0) return { w: channel.w, open: true, expires_at: Math.floor(Number(channel.expire_at)), seconds_left: left };
    return {
      w: channel.w, open: false, expires_at: Math.floor(Number(channel.expire_at)),
      why: `The address you answered from closed ${-left} s ago. Anything sent to it after that was refused at the door, so an empty result here does not mean nobody wrote back.`,
    };
  }

  /**
   * One live post of a scope, by its id, or null. A page holds up to 200 posts
   * and a scope can hold more: the cursor goes on until the post turns up or
   * the pages run out.
   */
  async scopedPost(scope, postId) {
    let after = 0;
    for (let pages = 0; pages < 50; pages++) {
      const page = await this.boardFind({ scope, after });
      const post = page.posts.find((found) => isObject(found) && found.id === postId);
      if (post) return post;
      const next = Math.floor(Number(page.next) || 0);
      if (!page.posts.length || next <= after) return null;
      after = next;
    }
    return null;
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
      // The mark is kept: with a byte order mark in front the text is not
      // JSON, and aamio-python and aamio-php hand it over as text. Dropped,
      // this runtime alone read the rest as JSON, a channel in it included.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.keys.open(message.from, raw));
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
    // Messages signed by a key that has left the address book, on an inbox
    // that named it: passed by like the ones the list keeps out, and said.
    const withheld = [];
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
    // What this read says of the messages it takes is said once the read is
    // written down. One that cannot be saved hands nothing over, and it said
    // replay_unknown for rows it never handed over: count 0 and no messages,
    // with a note on two of them (a review of 11 November 2026).
    const said = [];
    // What this read wrote to the archive, by delivery: kept in mind when the
    // cursor cannot be written, so the same rows are not written down again
    // when this process reads them again.
    const written = [];
    for (const raw of data.messages) {
      if (limit !== null && entries.length >= limit) break;
      const entry = this.readEntry(channel, raw);
      const allow = channel.allow || [];
      const excluded = allow.length > 0 && !(entry.verified && (allow.includes("*") || allow.includes(entry.from_key)));
      const gone = !excluded && entry.verified === true && this.leftTheBook(channel, entry.from_key);
      // What the message's addresses would bind is worked out before it is
      // weighed, so a conflict it carries is counted with it, and bound only when
      // it is taken: a conflict added after the weighing let 1146 bytes through a
      // budget of 900 (a review of 10 November 2026).
      const bindings = [];
      // A scope in the message: its key comes out here, before the message is
      // weighed, observed or shown, and goes to scopes.json or nowhere.
      let share = null;
      if (!excluded && !gone) {
        share = this.scopeSharePlan(entry);
        if (isObject(entry.body) && entry.verified && entry.from_key) {
          for (const field of ["reply_to", "channel"]) {
            const planned = this.bindingFor(field, entry.body[field], entry.from_key);
            if (planned !== null) bindings.push(planned);
          }
          const conflicts = bindings.filter((planned) => planned.conflict !== null).map((planned) => planned.conflict);
          if (conflicts.length) entry.binding_conflicts = conflicts;
        }
        // The archive's mark is weighed at its longer value, false, and with
        // archive_off where nothing is kept: a write that fails turns true
        // into false after the weighing, and a budget has to hold for what is
        // handed over. One that is written is a byte under.
        entry.archived = false;
        if (!this.archiveEnabled) entry.archive_off = true;
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
      if (gone) {
        withheld.push(entry.seq);
        continue;
      }
      if (entry.sha256 !== null) remember(channel, entry.sha256, entry.from_key);
      if (share !== null) await this.scopeShareTake(entry, share, said);
      for (const planned of bindings) {
        if (planned.conflict === null) {
          this.state.peers[planned.address] = entry.from_key;
        } else {
          said.push(["binding_conflict", `message ${entry.seq} names ${planned.address} as ${planned.field}, signed by ${this.nameForKey(entry.from_key) ?? entry.from_key}, and that address is already bound to ${this.nameForKey(planned.conflict.bound_to) ?? planned.conflict.bound_to}. The binding is kept.`]);
        }
      }
      // Received, readable, archived and handled are four different things.
      // The message is written down as it is handed over, with the thread's
      // instance and without the archive's own mark, before the cursor is: a
      // process that stops between the two reads it again, and one that did
      // it the other way round passed it by with nothing kept. A write that
      // fails never costs the rest of the batch, and is said in attention,
      // not on the message, which has to be the size it was weighed at.
      const { archived: weighedAs, archive_off: off, ...row } = entry;
      row.kind = "received";
      if (typeof channel.instance === "string") row.instance = channel.instance;
      const delivery = this.deliveryOf(channel, entry);
      if (this.archiveEnabled) {
        if (delivery !== null && this.writtenDown.has(delivery)) {
          // Written down at a read whose cursor could not be saved, by this process.
          entry.archived = true;
        } else {
          try {
            entry.archived = (await this.archive(channel.label, row)) !== false;
            if (entry.archived && delivery !== null) written.push(delivery);
          } catch (error) {
            entry.archived = false;
            said.push(["archive_failed", `message ${entry.seq} was handed over and could not be written to the archive: ${error.code || error.name}: ${error.message}. The archive does not have it.`]);
          }
        }
      }
      entries.push(entry);
    }
    // Messages whose bytes this channel handed over before, which an earlier
    // version recorded without who sent them: whether each is a copy cannot be
    // told, and it is said rather than guessed.
    const unknown = entries.filter((entry) => entry.replay_unknown).map((entry) => entry.seq);
    if (unknown.length) {
      said.push(["replay_unknown", `message(s) ${unknown.join(", ")} carry the bytes of a message this channel handed over before, which an earlier version recorded without who sent it, so whether each is a copy cannot be told: each comes with replay false and replay_unknown true.`]);
    }
    if (keptOut.length) {
      const openedFor = (channel.allow || []).includes("*") ? "any key, signed only" : `${channel.allow.length} named key(s)`;
      said.push(["kept_out", `${keptOut.length} message(s) (seq ${keptOut.join(", ")}): this channel was opened for ${openedFor}, and these did not satisfy that list as checked here. They are not handed over.`]);
    }
    if (withheld.length) {
      said.push(["removed_key", `${withheld.length} message(s) (seq ${withheld.join(", ")}) are signed by a key that is no longer in the address book, on an inbox that was given to it. They are not handed over and not archived. Add the key as a partner again to take what it writes from then on.`]);
    }
    if (oversized) {
      said.push(["over_budget", `message ${oversized.seq} on this channel is ${oversized.weight} bytes as handed over here, larger than the whole byte budget of ${maxBytes} this read asked for. It had already come, so it is handed over on its own rather than kept back for ever, and this read is over its budget on purpose.`]);
    }
    // Rows the service sent that this read left because its own limit was
    // reached: a service that does not take X-Limit sends them all, and the read
    // that stopped on its own said nothing (a review of 10 November 2026).
    const leftHere = !stoppedAtBudget && limit !== null && entries.length >= limit && data.messages.length > entries.length + keptOut.length + withheld.length;
    if (stoppedAtBudget) {
      said.push(["more", `this read stopped at the byte budget it asked for, ${maxBytes} bytes of messages as they are handed over here, and left the rest at the service. Nothing was passed over: the cursor stands at the last message handed over, so read again for the rest.`]);
    } else if (leftHere || (data.more === true && !isObject(data.too_large))) {
      // The service says more both when the count this read asked for was
      // reached and when the byte budget was. A note that blamed a budget
      // nobody set would send the reader looking for the wrong cause.
      const atLimit = leftHere || (limit !== null && data.messages.length >= limit);
      said.push(["more", atLimit
        ? "this read handed over as many messages as its limit allows, and the service has more waiting on this channel. Nothing was passed over: the cursor stands at the last message handed over, so read again for the rest."
        : maxBytes !== null
          ? "the service had more waiting on this channel than the byte budget this read asked for, so it sent what fits and kept the rest. Read again for it: the cursor stands at the last message handed over."
          : "the service says it has more waiting on this channel than it sent. Nothing was passed over: the cursor stands at the last message handed over, so read again for the rest."]);
    }
    // A read that stopped early moves the cursor to the last row it took and
    // no further: next would skip the rest of the page.
    const stoppedEarly = stoppedAtBudget || leftHere;
    if (stoppedEarly) {
      if (lastSeq !== null) channel.after = lastSeq;
    } else if (Number.isInteger(data.next)) channel.after = data.next;
    else if (lastSeq !== null) channel.after = Math.max(channel.after, lastSeq);
    try {
      await this.saveRead();
    } catch (error) {
      for (const delivery of written) this.writtenDown.add(delivery);
      throw error;
    }
    for (const [state, what] of said) this.note(channel.label, state, what, channel.w);
    // The copies board replies keep, with the archive's mark and the thread's
    // instance, which the message handed over does not carry: one delivery is
    // known by its address, instance and seq in memory as it is in the archive.
    if (entries.length) {
      const held = this.received.get(channel.w) ?? [];
      for (const entry of entries) {
        held.push(typeof channel.instance === "string" ? { ...entry, instance: channel.instance } : { ...entry });
        this.writtenDown.delete(this.deliveryOf(channel, entry));
      }
      this.received.set(channel.w, held);
    }
    // The trace follows what was handed over: recorded after the read is
    // written down, in attention when it cannot be, and never on the messages,
    // which are the size they were weighed at.
    await this.traceRead(channel, entries);
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
    // Taken, and anchored when that was asked: a record of it that cannot be
    // written is said beside it.
    const archiveError = await this.archiveSafely(channel.label, { kind: "receipt", at: this.now(), result }, `the receipt for ${channel.label}`);
    if (archiveError !== null) result.archive_error = archiveError;
    return result;
  }

  /** Messages on every channel still read, the inbox first. The inbox is opened and presence published as the read starts. */
  async read({ wait = 0, limit = 50, maxBytes = null } = {}) {
    const noted = this.attention.length;
    await this.ensureInbox();
    await this.publishPresence();
    this.dropExpired();
    const now = this.now();
    // What was read of a thread is kept for its receipt while the receipt can
    // still be taken, and no longer: a server that ran for days held the rows
    // of every inbox it had read (a review of 10 November 2026).
    for (const w of [...this.observed.keys()]) {
      const known = this.state.channels.find((c) => isObject(c) && c.w === w);
      if (!known || Number(known.expire_at) + RECEIPT_KEEP < now) this.observed.delete(w);
    }
    // A muted inbox too: it is read until it expires, for the partners still in the book.
    const channels = this.state.channels.filter((c) => isObject(c) && Number(c.expire_at) > now)
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
