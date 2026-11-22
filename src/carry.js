// The carrier envelope aamio-carry-v1, for transports under contract 3.
//
// The specification is docs/aamio-tillegg-kontrakt-3-2026-11-15.md in the
// service repository, with its vectors beside it; test/carry_v1_vectors.json is
// a copy. Bytes in and bytes out, with no state, so it runs wherever aamio.js
// does: the sessions that decide whether a message is taken are in
// node-carry-state.js.
//
// tweetnacl verifies an Ed25519 signature without the checks libsodium makes on
// the key, R and S. They are made here, before its verification, as section A9
// says: without them, a key of small order in the address book would take R as
// the neutral point and S as zero as a valid signature on every message.

import nacl from "tweetnacl";
import { curvePublic, sha256 } from "./aamio.js";

const ascii = (text) => Uint8Array.from(text, (character) => character.charCodeAt(0));

export const DOMAIN = ascii("aamio-carry-v1\n");
export const NONCE_LABEL = ascii("aamio-carry-v1 nonce\n");
export const ESK_LABEL = ascii("aamio-carry-v1 esk\n");
export const CHALLENGE_LABEL = ascii("aamio-carry-v1 challenge\n");
export const MAGIC = ascii("AMC1");
export const FRAME_MAGIC = ascii("AF");
export const FRAME_HEADER = 9;

export const READABLE = 1;
export const SEALED = 2;
export const MESSAGE = 1;
export const RECEIPT = 2;
export const ASK = 3;
export const CHALLENGE = 4;
export const OPEN = 5;
export const CLOSE = 6;
export const KINDS = [MESSAGE, RECEIPT, ASK, CHALLENGE, OPEN, CLOSE];
export const BOUND = 0x01;
export const STORED = 1;
export const PROCESSED = 2;

export const READABLE_HEAD = 33;
export const SEALED_OUTER = 43;
export const SEALED_SIGNED_OUTER = 41;
export const INNER_HEAD = 24;
export const SIGNATURE = 64;
export const MAC = 16;
export const RECEIPT_BODY = 45;
export const NONCE_BYTES = 16;
export const MAX_CONTENT = 65431;
export const CANDIDATES = 4;

const fromHex = (text) => Uint8Array.from(text.match(/../g), (pair) => parseInt(pair, 16));
const L_LE = fromHex("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010");
const P_LE = fromHex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f");
// Appendix 1: Ed25519 encodings of points of small order, compared with bit 255 cleared.
const SMALL_ORDER = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];

/** An envelope, a frame or a write refused, with the code the specification gives for it. */
export class CarryRefused extends Error {
  constructor(code, detail = "") {
    super(code + (detail ? ": " + detail : ""));
    this.name = "CarryRefused";
    this.code = code;
    // What was read of the envelope when it was refused after its sender was verified, so the carrier can say who it
    // came from (A7). null for a refusal before that.
    this.reading = null;
  }
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const u8 = (value) => Uint8Array.of(value);
const u16 = (value) => Uint8Array.of(value >>> 8, value & 0xff);
const u32 = (value) => Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const u64 = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
};
const read16 = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];
const read32 = (bytes, at) => ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The first 4 bytes of SHA-256 over a key: aamio's hash prefix, as bytes. */
export function hint(pk) {
  return sha256(pk).slice(0, 4);
}

/**
 * The challenge as it goes into the signature and the ephemeral key: its length
 * first, 0x00 for none. Without the length, a 16-byte challenge before a bound
 * header could be the same bytes as an unbound header that begins with them
 * (a review of 15 November 2026).
 */
export function bind(binding) {
  return binding == null ? u8(0) : concat(u8(binding.length), binding);
}

export function boxNonce(epk, recipientXpk) {
  return nacl.hash(concat(NONCE_LABEL, epk, recipientXpk)).slice(0, 24);
}

/** N for the challenge numbered `number` that keys give: the count never repeats, so N is new even where rnd does. */
export function challengeNonce(keys, rnd, initiatorPk, session, number) {
  return nacl.hash(concat(CHALLENGE_LABEL, keys.seed, rnd, initiatorPk, session, u64(number))).slice(0, NONCE_BYTES);
}

export function receiptBody(receiptKind, session, counter, envelope) {
  return concat(u8(receiptKind), session, u32(counter), sha256(envelope));
}

function checkWritable(kind, flags, content, binding) {
  if (content.length > MAX_CONTENT) throw new CarryRefused("carry_too_large", `${content.length} bytes of content, and the most is ${MAX_CONTENT}`);
  if (!KINDS.includes(kind)) throw new TypeError(`unknown kind ${kind}`);
  if (!(kind === MESSAGE ? [0, BOUND] : [0]).includes(flags)) throw new TypeError(`flags ${flags} are not allowed for kind ${kind}`);
  if ((binding != null) !== Boolean(flags & BOUND)) throw new TypeError("a bound message needs the challenge, and only a bound message has one");
  if (binding != null && binding.length !== NONCE_BYTES) throw new TypeError("the challenge is 16 bytes");
}

/**
 * One envelope from keys to recipientPk, readable or sealed, as A3 and A4 say.
 * rnd is only for the vectors: a sealed envelope otherwise takes 32 new random
 * bytes, and its ephemeral key is derived from them, the sender's seed and
 * everything signed, so two envelopes that sign different bytes never share one.
 */
export function write(keys, recipientPk, mode, kind, flags, session, counter, deadline, content, { binding = null, rnd = null } = {}) {
  checkWritable(kind, flags, content, binding);
  if (session.length !== 8) throw new TypeError("a session is 8 bytes");
  for (const [name, value] of [["counter", counter], ["deadline", deadline]]) {
    // A number outside its four bytes, or not a whole number, is refused, never turned by setUint32 into one that fits.
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${name} is a whole number from 0 to 2^32 - 1, not ${value}`);
  }
  const fields = concat(session, u32(counter), u32(deadline), u16(content.length), content);
  const prefix = concat(DOMAIN, keys.publicRaw, recipientPk, bind(binding));
  if (mode === READABLE) {
    const head = concat(MAGIC, Uint8Array.of(READABLE, kind, flags), hint(recipientPk), hint(keys.publicRaw), fields);
    return concat(head, nacl.sign.detached(concat(prefix, head), keys.signSecret));
  }
  if (mode !== SEALED) throw new TypeError(`unknown mode ${mode}`);
  const innerHead = concat(Uint8Array.of(kind, flags), hint(keys.publicRaw), fields);
  const random = rnd ?? nacl.randomBytes(32);
  const esk = nacl.hash(concat(ESK_LABEL, keys.seed, random, recipientPk, bind(binding), innerHead)).slice(0, 32);
  const epk = nacl.scalarMult.base(esk);
  const outer = concat(MAGIC, u8(SEALED), hint(recipientPk), epk);
  const inner = concat(innerHead, nacl.sign.detached(concat(prefix, outer, innerHead), keys.signSecret));
  const recipientXpk = curvePublic(recipientPk);
  const ciphertext = nacl.box(inner, boxNonce(epk, recipientXpk), recipientXpk, esk);
  esk.fill(0);
  return concat(outer, u16(ciphertext.length), ciphertext);
}

/** The frames of A8 for a medium whose largest frame is frameLimit bytes. */
export function split(envelope, frameLimit) {
  const part = frameLimit - FRAME_HEADER;
  if (part < 1) throw new CarryRefused("frame_too_small", `a frame of ${frameLimit} bytes has no room after its 9-byte header`);
  const count = Math.ceil(envelope.length / part);
  if (count > 255) throw new CarryRefused("carry_too_large", `${envelope.length} bytes need ${count} frames of ${frameLimit} bytes, and the most is 255`);
  const tag = sha256(envelope).slice(0, 4);
  const frames = [];
  for (let index = 0; index < count; index++) {
    frames.push(concat(FRAME_MAGIC, u8(0), tag, Uint8Array.of(index, count), envelope.slice(index * part, (index + 1) * part)));
  }
  return frames;
}

/** The frames of one message, in any order, as one envelope; or the first code of A8. */
export function reassemble(frames) {
  const group = new Map();
  let tag = null;
  let count = null;
  for (const frame of frames) {
    if (frame.length < FRAME_HEADER + 1) throw new CarryRefused("frame_bad_length");
    if (frame[0] !== FRAME_MAGIC[0] || frame[1] !== FRAME_MAGIC[1]) throw new CarryRefused("frame_bad_magic");
    if (frame[2] !== 0) throw new CarryRefused("frame_unknown_scheme");
    const thisTag = frame.slice(3, 7);
    const index = frame[7];
    const thisCount = frame[8];
    if (thisCount < 1 || index >= thisCount) throw new CarryRefused("frame_bad_index");
    if (tag === null) {
      tag = thisTag;
      count = thisCount;
    } else if (!equal(thisTag, tag)) throw new CarryRefused("frame_other_message");
    else if (thisCount !== count) throw new CarryRefused("frame_count_mismatch");
    const part = frame.slice(FRAME_HEADER);
    if (group.has(index) && !equal(group.get(index), part)) throw new CarryRefused("frame_conflict");
    group.set(index, part);
  }
  if (tag === null || group.size !== count) throw new CarryRefused("frame_incomplete");
  const envelope = concat(...Array.from({ length: count }, (_, index) => group.get(index)));
  if (!equal(sha256(envelope).slice(0, 4), tag)) throw new CarryRefused("frame_tag_mismatch");
  return envelope;
}

function below(a, b) {
  for (let i = 31; i >= 0; i--) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function smallOrder(encoded) {
  const masked = Uint8Array.from(encoded);
  masked[31] &= 0x7f;
  return SMALL_ORDER.includes(toHex(masked));
}

/** A9, step 9: the key canonical and not of small order, S below L, R not of small order, then the verification itself. */
export function strictVerify(pk, data, signature) {
  if (pk.length !== 32 || signature.length !== SIGNATURE) return false;
  const masked = Uint8Array.from(pk);
  masked[31] &= 0x7f;
  if (!below(masked, P_LE) || smallOrder(pk)) return false;
  if (!below(signature.slice(32), L_LE) || smallOrder(signature.slice(0, 32))) return false;
  try {
    return nacl.sign.detached.verify(data, signature, pk);
  } catch {
    return false;
  }
}

function kindAndFlags(kind, flags) {
  if (!KINDS.includes(kind)) throw new CarryRefused("carry_unknown_kind");
  if (flags & ~(kind === MESSAGE ? BOUND : 0)) throw new CarryRefused("carry_reserved_flags");
}

function checkContent(kind, counter, deadline, content, session) {
  if (kind === MESSAGE) {
    if (counter < 1) throw new CarryRefused("carry_bad_content", "a message counts from 1");
    return;
  }
  if (counter !== 0 || deadline !== 0) throw new CarryRefused("carry_bad_content", "only a message has a counter or a deadline");
  if (kind === RECEIPT) {
    if (content.length !== RECEIPT_BODY || ![STORED, PROCESSED].includes(content[0]) || !equal(content.slice(1, 9), session)) {
      throw new CarryRefused("carry_bad_content", "a receipt is 45 bytes about a message in its own session");
    }
  } else if (kind === CHALLENGE || kind === OPEN) {
    if (content.length !== NONCE_BYTES) throw new CarryRefused("carry_bad_content", "a challenge and an open carry the 16-byte nonce");
  } else if (content.length !== 0) throw new CarryRefused("carry_bad_content", "an ask and a close carry nothing");
}

/**
 * The checks of A9, in that order: what was read, or CarryRefused with the
 * first code. known is the address book's raw keys bound to this transport, in
 * its order; bindingFor(pk, session) gives the challenge a bound message from
 * that key in that session is signed over, or null.
 */
export function read(envelope, keys, known, bindingFor = null) {
  if (envelope.length < 5 || !equal(envelope.slice(0, 4), MAGIC)) throw new CarryRefused("carry_bad_magic");
  const mode = envelope[4];
  const me = keys.publicRaw;
  let kind, flags, senderHint, fields, content, signature, signed;
  if (mode === READABLE) {
    if (envelope.length < READABLE_HEAD + SIGNATURE) throw new CarryRefused("carry_bad_length");
    kind = envelope[5];
    flags = envelope[6];
    const recipientHint = envelope.slice(7, 11);
    senderHint = envelope.slice(11, 15);
    fields = envelope.slice(15, 33);
    const n = read16(envelope, 31);
    if (n > MAX_CONTENT || envelope.length !== READABLE_HEAD + n + SIGNATURE) throw new CarryRefused("carry_bad_length");
    kindAndFlags(kind, flags);
    if (!equal(recipientHint, hint(me))) throw new CarryRefused("carry_not_for_me");
    content = envelope.slice(READABLE_HEAD, READABLE_HEAD + n);
    signature = envelope.slice(READABLE_HEAD + n);
    signed = envelope.slice(0, READABLE_HEAD + n);
  } else if (mode === SEALED) {
    if (envelope.length < SEALED_OUTER) throw new CarryRefused("carry_bad_length");
    const recipientHint = envelope.slice(5, 9);
    const epk = envelope.slice(9, 41);
    const m = read16(envelope, 41);
    if (envelope.length !== SEALED_OUTER + m || m < MAC + INNER_HEAD + SIGNATURE) throw new CarryRefused("carry_bad_length");
    if (!equal(recipientHint, hint(me))) throw new CarryRefused("carry_not_for_me");
    // A key of small order gives a shared secret of zeros. tweetnacl computes it
    // without a word, so it is refused here, before the box is opened.
    const shared = nacl.scalarMult(keys.curveSecret, epk);
    if (shared.every((byte) => byte === 0)) throw new CarryRefused("carry_open_failed");
    const inner = nacl.box.open(envelope.slice(SEALED_OUTER), boxNonce(epk, nacl.scalarMult.base(keys.curveSecret)), epk, keys.curveSecret);
    if (!inner) throw new CarryRefused("carry_open_failed");
    kind = inner[0];
    flags = inner[1];
    senderHint = inner.slice(2, 6);
    fields = inner.slice(6, 24);
    const n = read16(inner, 22);
    if (n > MAX_CONTENT || inner.length !== INNER_HEAD + n + SIGNATURE) throw new CarryRefused("carry_bad_length");
    kindAndFlags(kind, flags);
    content = inner.slice(INNER_HEAD, INNER_HEAD + n);
    signature = inner.slice(INNER_HEAD + n);
    signed = concat(envelope.slice(0, SEALED_SIGNED_OUTER), inner.slice(0, INNER_HEAD + n));
  } else throw new CarryRefused("carry_unknown_mode");

  const session = fields.slice(0, 8);
  const counter = read32(fields, 8);
  const deadline = read32(fields, 12);
  const candidates = known.filter((pk) => equal(hint(pk), senderHint)).slice(0, CANDIDATES);
  if (candidates.length === 0) throw new CarryRefused("carry_unknown_sender");
  let pairs;
  if (flags & BOUND) {
    pairs = candidates.map((pk) => [pk, bindingFor ? bindingFor(pk, session) : null]).filter(([, binding]) => binding != null);
    if (pairs.length === 0) throw new CarryRefused("carry_session_unknown");
  } else pairs = candidates.map((pk) => [pk, null]);
  const found = pairs.find(([pk, binding]) => strictVerify(pk, concat(DOMAIN, pk, me, bind(binding), signed), signature));
  if (!found) throw new CarryRefused("carry_bad_signature");
  checkContent(kind, counter, deadline, content, session);
  return { mode, kind, flags, sender: found[0], session, counter, deadline, content };
}
