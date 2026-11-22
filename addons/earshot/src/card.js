/*
 * The card a sound carries, and the rule that keeps every key out of the air.
 *
 *     aamio:scope/k7rq2m4xw5tbz3yd6ena
 *     aamio:scope/k7rq2m4xw5tbz3yd6ena?n=rom-42&t=1794200000
 *
 * The address is the write capability of a scope: whoever holds it can post
 * into the scope, and only whoever holds the key can read what was posted. It
 * is no secret in aamio, which is why it may go into the air. A key may not: a
 * scope's key and a thread's read key are 26 to 64 characters of a-z and 0-9,
 * and a card is made from exactly 20 characters of a-z and 2-7 and nothing
 * else. n is a name to keep the scope under, a hint the listener may take or
 * leave, and t the Unix time the card stops being good, so a recording played
 * again later is turned down. t is not signed: whoever recorded the sound can
 * read it, change t and make a new sound, so it stops a recording played as it
 * is, and a new scope for each occasion is still what stops the rest.
 *
 * A card this version does not read, with a parameter it does not know, is not
 * understood rather than read in part: a later card may name another service,
 * and must never be taken for one on this. The longest card is 80 bytes, of
 * the 128 a sound can carry. The same as aamio-python's aamio_earshot.card and
 * aamio-php's Aamio\Earshot\Card.
 *
 * From 0.5.0 a card may say more, when the one who plays it asks:
 *
 *     aamio:scope/k7rq2m4xw5tbz3yd6ena?n=rom-42&t=1794200000&v=lan,internet&k=KEY
 *     aamio:scope/k7rq2m4xw5tbz3yd6ena?t=1794200000&v=bt:00:00:5E:00:53:01&k=KEY
 *
 * v is the media they prefer answers over, in order, at most three, each once:
 * internet, the scope over aamio.at as a card without v means, or the medium of
 * a transport as its manifest names it, as lan, bt or sound. A transport's
 * medium may carry where they are reached on it, as the transport says it
 * (contract 3, B3: here): the medium, a colon, and 1 to 64 characters of
 * letters, digits, dots, colons, underscores and dashes, as
 * bt:00:00:5E:00:53:01 or lan:192.168.2.22:47474. That is the transport's own
 * address, which a listener's core binds to with aamio transport bind NAME
 * TRANSPORT --address. Nothing here knows what a medium is: a transport made
 * tomorrow is carried the same way. k is their public key, 43 characters of
 * base64url, which a listener binds a transport to; a card that names a medium
 * other than internet carries it. A medium a listener has no transport for is
 * said rather than refused, so a card from a later earshot naming a medium this
 * one does not know is still read. Such a card is up to 128 bytes, and only
 * earshot 0.5.0 and newer reads it. A public key is public, and a scope's key or
 * a thread's read key never takes its place: k refuses their shape as the
 * address does. The same card goes in a QR code, and aamio-qrcast reads it: the
 * shared vectors in the tests of aamio-js hold both to it.
 */

export const PREFIX = "aamio:scope/";
export const ADDRESS = /^[a-z2-7]{20}$/;
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
// A scope key or a thread's read key, as aamio makes them.
export const KEY_SHAPED = /^[a-z0-9]{26,64}$/;
// Unix seconds, as a card carries them: nine to eleven digits.
export const EXPIRY = /^[0-9]{9,11}$/;
export const MAX_BYTES = 128;
// The media a card may ask answers over: internet, or a transport's medium as its manifest names it, each alone or with
// where it is reached, as the transport says it: medium:address.
export const MEDIUM = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ENTRY = /^([a-z0-9][a-z0-9_-]{0,31})(?::([A-Za-z0-9._:-]{1,64}))?$/;
export const INTERNET = "internet";
export const VIA_MOST = 3;
// A public key as aamio prints it: 32 bytes of Ed25519 in base64url without padding.
export const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const VIA_FIX = "via is the media you prefer answers over, in order, at most three and each once: internet, the scope over aamio.at, "
  + "or the medium of a transport, as lan or bt, alone or with where you are reached on it as aamio transport here shows it, "
  + "as bt:00:00:5E:00:53:01. As text they are separated by commas, as bt:00:00:5E:00:53:01,internet.";
const KEY_FIX = "key is your public key, the 43 characters aamio whoami shows as key. A card that names a medium other than internet "
  + "carries it, and everyone within earshot hears it.";

/** The medium of a via entry: bt for bt:00:00:5E:00:53:01, internet for internet. */
export function mediumOf(entry) {
  return entry.split(":", 1)[0];
}

/** Input refused here, before anything was sent anywhere. */
export class Refused extends Error {
  constructor(reason, fix) {
    super(fix);
    this.reason = reason;
    this.fix = fix;
  }
}

/** Something heard that is not a card this version reads. */
export class NotUnderstood extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

export function checkAddress(address) {
  if (typeof address === "string" && ADDRESS.test(address)) return address;
  if (typeof address === "string" && KEY_SHAPED.test(address)) {
    throw new Refused("a_key_not_an_address", "That has the shape of a key, and a key never goes into the air: anyone who recorded the sound could read with it. Give the scope's write address, the 20 characters aamio scope list shows (aamio_scopes over MCP).");
  }
  throw new Refused("not_a_write_address", "Give the write address of a scope: exactly 20 characters of a-z and 2-7, as aamio scope list shows it (aamio_scopes over MCP). With no scope for the room yet, make one first with aamio scope new NAME (aamio_scope_new).");
}

export function checkName(name) {
  if (name === null || name === undefined || name === "") return null;
  if (typeof name === "string" && NAME.test(name)) return name;
  throw new Refused("invalid_name", "The name is a hint the listeners may keep the scope under: 1 to 32 letters, digits, dots, underscores and dashes, starting with a letter or a digit. It can be left out.");
}

/**
 * The entries in a v, each a medium or medium:address, or null when the text is not one: at most VIA_MOST, each medium
 * once, and internet never with an address.
 */
function mediaOf(via) {
  const entries = via.split(",");
  if (entries.length > VIA_MOST || entries.some((entry) => !ENTRY.test(entry))) return null;
  const media = entries.map(mediumOf);
  if (new Set(media).size !== media.length || entries.some((entry) => entry !== INTERNET && mediumOf(entry) === INTERNET)) return null;
  return entries;
}

/** The entries a card asks answers over, or null. internet alone is what a card without v says, so it adds nothing. */
export function checkVia(via) {
  if (via === null || via === undefined || via === "" || (Array.isArray(via) && via.length === 0)) return null;
  const text = Array.isArray(via) && via.every((entry) => typeof entry === "string") ? via.join(",") : via;
  const entries = typeof text === "string" ? mediaOf(text) : null;
  if (entries === null) throw new Refused("invalid_via", VIA_FIX);
  return entries.length === 1 && entries[0] === INTERNET ? null : entries;
}

/** Whether key is a public key as aamio prints it, and not a secret of the shape a card refuses. */
function isPublic(key) {
  if (typeof key !== "string" || !PUBLIC_KEY.test(key) || KEY_SHAPED.test(key)) return false;
  const raw = Buffer.from(key, "base64url");
  return raw.length === 32 && raw.toString("base64url") === key;
}

export function checkKey(key) {
  if (key === null || key === undefined || key === "") return null;
  if (typeof key === "string" && KEY_SHAPED.test(key)) {
    throw new Refused("a_key_not_a_public_key", "That has the shape of a scope's key or a thread's read key, and those never go into the air: anyone who recorded the sound could read with it. Give your public key, the 43 characters aamio whoami shows as key.");
  }
  if (!isPublic(key)) throw new Refused("invalid_key", KEY_FIX);
  return key;
}

/**
 * The card for a scope's write address, good until expires (Unix seconds) when given, or Refused. via and key make the
 * card of 0.5.0; without them it is the card earlier versions made.
 */
export function make(address, name = null, expires = null, via = null, key = null) {
  const checked = checkAddress(address);
  const named = checkName(name);
  const media = checkVia(via);
  const carried = checkKey(key);
  const parts = named ? ["n=" + named] : [];
  if (expires !== null && expires !== undefined) {
    if (typeof expires !== "number" || !Number.isInteger(expires) || !EXPIRY.test(String(expires))) {
      throw new Refused("invalid_expiry", "The time a card stops being good is Unix seconds, nine to eleven digits.");
    }
    parts.push("t=" + expires);
  }
  const beside = media === null ? [] : media.map(mediumOf).filter((medium) => medium !== INTERNET);
  if (beside.length && carried === null) {
    throw new Refused("key_needed", `A card that asks for answers over ${beside.join(", ")} carries the public key a listener binds that medium to. ${KEY_FIX}`);
  }
  if (media !== null) parts.push("v=" + media.join(","));
  if (carried !== null) parts.push("k=" + carried);
  const text = PREFIX + checked + (parts.length ? "?" + parts.join("&") : "");
  const size = Buffer.byteLength(text, "utf8");
  if (size > MAX_BYTES) {
    throw new Refused("card_too_long", `The card would be ${size} bytes, and one sound carries ${MAX_BYTES}: shorten the name or leave it out, or name fewer media. `
      + "Where a medium is reached takes room too: bt with its Bluetooth address is 18 bytes longer than bt alone.");
  }
  return text;
}

/**
 * The card in what was heard, as {kind: "scope", address, name, expires_at}, with via and key when it carries them, or
 * NotUnderstood. via is the entries as the card has them: a medium, or medium:address.
 */
export function read(text) {
  if (typeof text !== "string" || !text.startsWith(PREFIX)) throw new NotUnderstood("not_an_aamio_card");
  const rest = text.slice(PREFIX.length);
  const mark = rest.indexOf("?");
  const address = mark < 0 ? rest : rest.slice(0, mark);
  if (!ADDRESS.test(address)) throw new NotUnderstood("not_a_write_address");
  const found = { n: null, t: null, v: null, k: null };
  const seen = new Set();
  if (mark >= 0) {
    for (const part of rest.slice(mark + 1).split("&")) {
      const equals = part.indexOf("=");
      const key = equals < 0 ? part : part.slice(0, equals);
      if (!Object.hasOwn(found, key) || equals < 0 || seen.has(key)) throw new NotUnderstood("not_this_version");
      seen.add(key);
      const value = part.slice(equals + 1);
      if (key === "n" && !NAME.test(value)) throw new NotUnderstood("invalid_name");
      if (key === "t" && !EXPIRY.test(value)) throw new NotUnderstood("invalid_expiry");
      if (key === "v" && mediaOf(value) === null) throw new NotUnderstood("invalid_via");
      if (key === "k" && !isPublic(value)) throw new NotUnderstood("invalid_key");
      found[key] = value;
    }
  }
  const heard = { kind: "scope", address, name: found.n, expires_at: found.t !== null ? Number(found.t) : null };
  // A card without v and k reads as it always did, and one with them says them.
  if (found.v !== null) heard.via = found.v.split(",");
  if (found.k !== null) heard.key = found.k;
  return heard;
}
