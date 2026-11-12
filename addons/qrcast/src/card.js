import { NotUnderstood, Refused } from "./errors.js";

/*
 * The card a QR code carries, and the rule that keeps every key off the screen.
 *
 *     aamio:scope/k7rq2m4xw5tbz3yd6ena
 *     aamio:scope/k7rq2m4xw5tbz3yd6ena?n=stue-tv&t=1794200000
 *
 * The same card as the earshot add-on's, read by the same rules, so a card
 * seen and a card heard are one thing. The address is the write capability of
 * a scope: whoever holds it can post into the scope, and only whoever holds
 * the key can read what was posted. It is no secret in aamio, which is why it
 * may be shown. A key may not: a scope's key and a thread's read key are 26 to
 * 64 characters of a-z and 0-9, and a card is made from exactly 20 characters
 * of a-z and 2-7 and nothing else. n is a name to keep the scope under, a hint
 * the reader may take or leave, and t the Unix time the card stops being good,
 * so a photo of an old code is turned down. t is not signed: whoever saw the
 * code can make a new one with a later time, so a new scope for each occasion
 * is still what stops the rest.
 *
 * A card this version does not read, with a parameter it does not know, is not
 * understood rather than read in part: a later card may name another service,
 * and must never be taken for one on this. The longest card is 80 bytes. The
 * same as aamio-python's aamio_qrcast.card and aamio-php's Card.
 */

export const PREFIX = "aamio:scope/";
export const ADDRESS = /^[a-z2-7]{20}$/;
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
// A scope key or a thread's read key, as aamio makes them.
export const KEY_SHAPED = /^[a-z0-9]{26,64}$/;
// Unix seconds, as a card carries them: nine to eleven digits.
export const EXPIRY = /^[0-9]{9,11}$/;
export const MAX_BYTES = 128;

export function checkAddress(address) {
  if (typeof address === "string" && ADDRESS.test(address)) return address;
  if (typeof address === "string" && KEY_SHAPED.test(address)) {
    throw new Refused("a_key_not_an_address", "That has the shape of a key, and a key is never shown: anyone who saw or photographed the code could read with it. Give the scope's write address, the 20 characters aamio scope list shows (aamio_scopes over MCP).");
  }
  throw new Refused("not_a_write_address", "Give the write address of a scope: exactly 20 characters of a-z and 2-7, as aamio scope list shows it (aamio_scopes over MCP). With no scope for the room yet, make one first with aamio scope new NAME (aamio_scope_new).");
}

export function checkName(name) {
  if (name === null || name === undefined || name === "") return null;
  if (typeof name === "string" && NAME.test(name)) return name;
  throw new Refused("invalid_name", "The name is a hint the readers may keep the scope under: 1 to 32 letters, digits, dots, underscores and dashes, starting with a letter or a digit. It can be left out.");
}

/** The card for a scope's write address, good until expires (Unix seconds) when given, or Refused. */
export function make(address, name = null, expires = null) {
  const checked = checkAddress(address);
  const named = checkName(name);
  const parts = named !== null ? ["n=" + named] : [];
  if (expires !== null && expires !== undefined) {
    if (typeof expires !== "number" || !Number.isInteger(expires) || !EXPIRY.test(String(expires))) {
      throw new Refused("invalid_expiry", "The time a card stops being good is Unix seconds, nine to eleven digits.");
    }
    parts.push("t=" + expires);
  }
  return PREFIX + checked + (parts.length ? "?" + parts.join("&") : "");
}

/** The card in what was seen, as {kind: "scope", address, name, expires_at}, or NotUnderstood. */
export function read(text) {
  if (typeof text !== "string" || !text.startsWith(PREFIX)) throw new NotUnderstood("not_an_aamio_card");
  const rest = text.slice(PREFIX.length);
  const mark = rest.indexOf("?");
  const address = mark < 0 ? rest : rest.slice(0, mark);
  if (!ADDRESS.test(address)) throw new NotUnderstood("not_a_write_address");
  const found = { n: null, t: null };
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
      found[key] = value;
    }
  }
  return { kind: "scope", address, name: found.n, expires_at: found.t !== null ? Number(found.t) : null };
}
