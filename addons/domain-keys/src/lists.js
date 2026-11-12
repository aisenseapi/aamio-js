// The format of a domain key list: a strict reader, the match, a generator for
// the file, and the syntax of a domain. Nothing here opens a connection.
//
// A site can publish the public aamio keys it stands behind at
// https://<domain>/.well-known/aamio-keys.json as
// {"aamio_keys": 1, "keys": [{"key": "<43 characters>", "name": "support"}]}.
// JSON.parse keeps the last of two members of the same name without a word, so
// it cannot hold the format's rule about duplicates, and the reader here is its
// own. test/domain_keys_vectors.json holds what every client answers.
//
// Between the two marks below is the format code of the aamio package itself,
// as its src/aamio.js has it, so the add-on and the client read a list the
// same way; test/lists.test.mjs compares the two when the client's source is
// beside this package. Above it is what that code needs from Node, and below
// it the check of a local file.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const utf8 = (text) => new TextEncoder().encode(text);
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64url = (text) => Buffer.from(text, "base64url");
const sha256hex = (data) => createHash("sha256").update(data).digest("hex");

// ---- from aamio-js/src/aamio.js ----
export const DOMAIN_KEYS_VERSION = 1;
export const DOMAIN_KEYS_PATH = "/.well-known/aamio-keys.json";
export const DOMAIN_KEYS_MAX_BYTES = 16384;
export const DOMAIN_KEYS_MAX_KEYS = 64;
const DOMAIN_MAX_DEPTH = 16;
const DOMAIN_MAX_INTEGER = 9007199254740991n;

/** A list that is not version 1. reason says why, without echoing the content. */
export class InvalidDomainKeys extends Error {
  constructor(reason) {
    super("invalid domain key list: " + reason);
    this.name = "InvalidDomainKeys";
    this.reason = reason;
  }
}

/** A public key as aamio writes it: 32 bytes, 43 characters, one spelling only. */
export function canonicalKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  // A last character carrying bits past the 32 bytes decodes to the same bytes
  // as another string; only the one an encoder writes is the key.
  return b64url(unb64url(value)) === value;
}

/** A name a list can carry: 1 to 64 characters of a-z, 0-9, dot, underscore and dash. */
export function validDomainKeyName(value) {
  return typeof value === "string" && /^[a-z0-9._-]{1,64}$/.test(value);
}

/**
 * The exact host a list is read from, in lowercase, or null. Plain ASCII names of
 * two labels or more. No port, path, IP literal, trailing dot, underscore or
 * space is trimmed into shape. Internationalised names, xn-- labels, wait until
 * every client converts them the same way. www.example.org and example.org are
 * different places, and no parent domain lends its list to a child.
 */
export function normaliseDomain(value) {
  // ASCII first: toLowerCase makes a k of the Kelvin sign.
  if (typeof value !== "string" || !/^[\x00-\x7f]*$/.test(value)) return null;
  const domain = value.toLowerCase();
  const labels = domain.split(".");
  if (domain.length < 1 || domain.length > 253 || labels.length < 2) return null;
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) || label.startsWith("xn--")) return null;
  }
  // A last label of digits or hex is an old spelling of an IPv4 address.
  return /^(?:[0-9]+|0x[0-9a-f]+)$/.test(labels[labels.length - 1]) ? null : domain;
}

/** Where the list of this exact domain is, over HTTPS on the default port, or null. */
export function domainKeysUrl(domain) {
  const host = normaliseDomain(domain);
  return host === null ? null : "https://" + host + DOMAIN_KEYS_PATH;
}

class DomainReader {
  // JSON with the format's limits. Objects become a Map, so __proto__ is a member
  // like any other, lists an Array, integers a BigInt and other numbers a number.
  // A string holds UTF-16, so a lone surrogate stays what it is and a pair is the
  // character it spells.
  constructor(text) {
    this.text = text;
    this.at = 0;
  }

  skip() {
    while (this.at < this.text.length && " \t\r\n".includes(this.text[this.at])) this.at++;
  }

  bad(reason = "invalid_json") {
    return new InvalidDomainKeys(reason);
  }

  value(level) {
    this.skip();
    const c = this.text[this.at];
    if (c === "{") return this.members(level);
    if (c === "[") return this.rows(level);
    if (c === '"') return this.string();
    for (const [word, meaning] of [["true", true], ["false", false], ["null", null]]) {
      if (this.text.startsWith(word, this.at)) {
        this.at += word.length;
        return meaning;
      }
    }
    return this.number();
  }

  members(level) {
    if (level > DOMAIN_MAX_DEPTH) throw this.bad("depth_limit");
    this.at++;
    const found = new Map();
    this.skip();
    if (this.text[this.at] === "}") {
      this.at++;
      return found;
    }
    for (;;) {
      this.skip();
      if (this.text[this.at] !== '"') throw this.bad();
      const name = this.string();
      if (found.has(name)) throw this.bad("duplicate_member");
      this.skip();
      if (this.text[this.at] !== ":") throw this.bad();
      this.at++;
      found.set(name, this.value(level + 1));
      this.skip();
      const next = this.text[this.at++];
      if (next === "}") return found;
      if (next !== ",") throw this.bad();
    }
  }

  rows(level) {
    if (level > DOMAIN_MAX_DEPTH) throw this.bad("depth_limit");
    this.at++;
    const found = [];
    this.skip();
    if (this.text[this.at] === "]") {
      this.at++;
      return found;
    }
    for (;;) {
      found.push(this.value(level + 1));
      this.skip();
      const next = this.text[this.at++];
      if (next === "]") return found;
      if (next !== ",") throw this.bad();
    }
  }

  string() {
    const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    this.at++;
    let out = "";
    for (;;) {
      if (this.at >= this.text.length) throw this.bad();
      const c = this.text[this.at++];
      if (c === '"') return out;
      if (c < " ") throw this.bad();
      if (c !== "\\") {
        out += c;
        continue;
      }
      const escape = this.text[this.at++];
      if (escape === "u") {
        const digits = this.text.slice(this.at, this.at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw this.bad();
        this.at += 4;
        out += String.fromCharCode(parseInt(digits, 16));
      } else if (Object.hasOwn(simple, escape ?? "")) {
        out += simple[escape];
      } else {
        throw this.bad();
      }
    }
  }

  number() {
    const rest = this.text.slice(this.at);
    const found = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(rest);
    if (found === null) throw this.bad();
    this.at += found[0].length;
    if (found[1] !== undefined || found[2] !== undefined) {
      if (!Number.isFinite(Number(found[0]))) throw this.bad("non_finite_number");
      return Number(found[0]);
    }
    const value = BigInt(found[0]);
    if (value > DOMAIN_MAX_INTEGER || value < -DOMAIN_MAX_INTEGER) throw this.bad("integer_range");
    return value;
  }
}

/**
 * The entries of a version 1 list, as { key } or { key, name }, from the exact
 * bytes. A duplicate key, a duplicate member name in any object or one bad entry
 * makes the whole document invalid: a list is never valid with the bad part left
 * out. Throws InvalidDomainKeys.
 */
export function parseDomainKeys(raw) {
  if (!(raw instanceof Uint8Array)) throw new InvalidDomainKeys("not_bytes");
  if (raw.length > DOMAIN_KEYS_MAX_BYTES) throw new InvalidDomainKeys("body_limit");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new InvalidDomainKeys("not_utf8");
  }
  if (text.startsWith("\ufeff")) throw new InvalidDomainKeys("byte_order_mark");
  const reader = new DomainReader(text);
  const value = reader.value(1);
  reader.skip();
  if (reader.at !== text.length) throw new InvalidDomainKeys("invalid_json");
  if (!(value instanceof Map)) throw new InvalidDomainKeys("object_required");
  // A BigInt and nothing looser: 1.0, 1e0 and true are not the integer 1.
  if (value.get("aamio_keys") !== BigInt(DOMAIN_KEYS_VERSION)) throw new InvalidDomainKeys("unsupported_version");
  const rows = value.get("keys");
  if (!Array.isArray(rows) || rows.length > DOMAIN_KEYS_MAX_KEYS) throw new InvalidDomainKeys("invalid_keys");
  const seen = new Set();
  const entries = [];
  for (const row of rows) {
    if (!(row instanceof Map) || !canonicalKey(row.get("key"))) throw new InvalidDomainKeys("invalid_key");
    const key = row.get("key");
    if (seen.has(key)) throw new InvalidDomainKeys("duplicate_key");
    seen.add(key);
    const entry = { key };
    // has, since a name of null is a bad name and not a missing one.
    if (row.has("name")) {
      if (!validDomainKeyName(row.get("name"))) throw new InvalidDomainKeys("invalid_name");
      entry.name = row.get("name");
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Whether this exact document lists key, and under name when one is given.
 *
 * status is listed, not_listed or invalid. not_listed is no evidence of fraud: a
 * key rotated out, the wrong name or the wrong domain look the same. The document
 * hash is of the exact bytes compared, for comparison and fault finding; the
 * domain did not sign it. The key is the caller's to choose and to answer for,
 * which the result says as subject_source.
 */
export function matchDomainKey(raw, key, name = null) {
  const subject_source = "supplied_key";
  if (!canonicalKey(key)) return { status: "invalid", reason: "invalid_subject_key", subject_source };
  if (name !== null && !validDomainKeyName(name)) return { status: "invalid", reason: "invalid_requested_name", subject_source };
  let entries;
  try {
    entries = parseDomainKeys(raw);
  } catch (error) {
    if (!(error instanceof InvalidDomainKeys)) throw error;
    return { status: "invalid", reason: "invalid_document", detail: error.reason, subject_source };
  }
  const document_sha256 = sha256hex(raw);
  for (const entry of entries) {
    if (entry.key === key && (name === null || entry.name === name)) {
      return { status: "listed", reason: "key_listed", matched_name: entry.name ?? null, document_sha256, subject_source };
    }
  }
  return { status: "not_listed", reason: "key_or_name_not_listed", document_sha256, subject_source };
}

/**
 * The file for a site to publish, as bytes. They are fixed, so every generator
 * gives the same file for the same list: two spaces of indentation, aamio_keys
 * before keys, key before name, ASCII only, and a line break at the end. An empty
 * list is allowed, since that is how a site says it lists no key, so callers ask
 * for it on purpose. A list this would refuse to read is refused here as well.
 */
export function makeDomainKeys(entries) {
  const rows = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!canonicalKey(entry?.key)) throw new InvalidDomainKeys("invalid_key");
    if (seen.has(entry.key)) throw new InvalidDomainKeys("duplicate_key");
    seen.add(entry.key);
    let row = '    {\n      "key": "' + entry.key + '"';
    if (entry.name !== undefined && entry.name !== null) {
      if (!validDomainKeyName(entry.name)) throw new InvalidDomainKeys("invalid_name");
      row += ',\n      "name": "' + entry.name + '"';
    }
    rows.push(row + "\n    }");
  }
  if (rows.length > DOMAIN_KEYS_MAX_KEYS) throw new InvalidDomainKeys("invalid_keys");
  const list = rows.length === 0 ? "[]" : "[\n" + rows.join(",\n") + "\n  ]";
  const raw = utf8('{\n  "aamio_keys": ' + DOMAIN_KEYS_VERSION + ',\n  "keys": ' + list + "\n}\n");
  parseDomainKeys(raw);
  return raw;
}
// ---- end of what is from aamio-js/src/aamio.js ----

/**
 * A local file against the format, with its exit code. It reads the one file
 * and nothing else: no domain and no runtime's home. What it says is said
 * every time, so a file found valid here is never taken for a domain read.
 */
export async function checkFile(path) {
  let raw;
  try {
    if (typeof path !== "string" || !path) throw new Error("no path");
    raw = new Uint8Array(await readFile(path));
  } catch {
    return [{ error: "local_file_unreadable" }, 2];
  }
  let result;
  let code;
  try {
    result = { format_valid: true, keys: parseDomainKeys(raw).length };
    code = 0;
  } catch (error) {
    if (!(error instanceof InvalidDomainKeys)) throw error;
    result = { format_valid: false, reason: "invalid_document", detail: error.reason };
    code = 2;
  }
  return [{ ...result, source: "local_file", domain_checked: false }, code];
}
