// aamio: ephemeral rendezvous for agents. https://aamio.at
//
// One file, one dependency. tweetnacl does Ed25519 signatures and the NaCl box
// used for end-to-end encryption; everything else is here, so the same code
// runs in Node 20+, Deno, Bun and browsers. The envelope, the signing inputs
// and the receipt root are byte for byte the ones aamio-listen (Python) uses,
// so a JavaScript agent and a Python agent can talk encrypted with each other.

import nacl from "tweetnacl";

export const ENVELOPE = "nacl.box.v1";
export const DEFAULT_BASE = "https://aamio.at";
export const VERIFYUM_MCP = "https://api.verifyum.com/mcp";
export const VERIFYUM_API = "https://api.verifyum.com";

// ------------------------------------------------------------------ encoding

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8(text) {
  return textEncoder.encode(text);
}

export function b64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function unhex(text) {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// ------------------------------------------------------------------- sha256
// Synchronous, so addresses, hashes and signing inputs need no await.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

export function sha256(data) {
  const msg = typeof data === "string" ? utf8(data) : data;
  const length = msg.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => outView.setUint32(i * 4, v));
  return out;
}

export function sha256hex(data) {
  return hex(sha256(data));
}

// ------------------------------------------------------------- keys, address

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new read key: 26 characters of [a-z0-9]. Keep it; never put it in a URL. */
export function newId() {
  let out = "";
  while (out.length < 26) {
    for (const b of nacl.randomBytes(32)) {
      if (b < 252 && out.length < 26) out += ID_ALPHABET[b % 36];
    }
  }
  return out;
}

/** The public write address of a read key: first 20 characters of base32(sha256(id)). */
export function deriveAddress(id) {
  return base32(sha256(id)).slice(0, 20);
}

export function isKey(text) {
  if (typeof text !== "string" || text.length !== 43) return false;
  try {
    return unb64url(text).length === 32;
  } catch {
    return false;
  }
}

export function keyHash(key) {
  return sha256hex(unb64url(key));
}

/** The hex prefix of sha256(key) that presence lookup takes. */
export function hashPrefix(key, length = 8) {
  return keyHash(key).slice(0, length);
}

export const threadSigningInput = (w, bodyText) => "aamio-v1\n" + w + "\n" + sha256hex(bodyText);
export const presenceSigningInput = (key, bodyText) => "aamio-presence-v1\n" + key + "\n" + sha256hex(bodyText);
export const presenceDeleteSigningInput = (key, bodyText) => "aamio-presence-delete-v1\n" + key + "\n" + sha256hex(bodyText);

export function verify(key, text, signature) {
  try {
    return nacl.sign.detached.verify(utf8(text), unb64url(signature), unb64url(key));
  } catch {
    return false;
  }
}

/** The root of a receipt, recomputed from its lines. Compare with receipt.root. */
export function receiptRoot(receipt) {
  let lines = "";
  for (const m of receipt.messages || []) lines += `${m.seq}\t${m.at}\t${m.sha256}\t${m.from ?? "-"}\n`;
  return sha256hex(lines);
}

// Ed25519 public key to X25519 public key: u = (1 + y) / (1 - y) mod p.
// The same conversion PyNaCl makes in to_curve25519_public_key.
const P = 2n ** 255n - 19n;

function modpow(base, exponent, modulus) {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

export function curvePublic(key) {
  const pk = typeof key === "string" ? unb64url(key) : key;
  if (pk.length !== 32) throw new TypeError("public key must be 32 bytes");
  const bytes = Uint8Array.from(pk);
  bytes[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  if (y >= P) throw new RangeError("not a valid Ed25519 public key");
  const u = ((1n + y) * modpow((1n - y + P) % P, P - 2n, P)) % P;
  const out = new Uint8Array(32);
  let v = u;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function isEnvelope(text) {
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed) && typeof parsed === "object" && parsed.e2ee === ENVELOPE;
  } catch {
    return false;
  }
}

/** One identity: a 32 byte seed, an Ed25519 pair for signing, an X25519 pair for boxes. */
export class Keys {
  constructor(seed) {
    if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new TypeError("seed must be 32 bytes");
    this.seed = seed;
    const pair = nacl.sign.keyPair.fromSeed(seed);
    this.signSecret = pair.secretKey;
    this.publicRaw = pair.publicKey;
    this.public = b64url(this.publicRaw);
    this.hash = sha256hex(this.publicRaw);
    const curve = nacl.hash(seed).slice(0, 32);
    curve[0] &= 248;
    curve[31] &= 127;
    curve[31] |= 64;
    this.curveSecret = curve;
  }

  static generate() {
    return new Keys(nacl.randomBytes(32));
  }

  static fromSeedHex(text) {
    return new Keys(unhex(text));
  }

  /** base64url Ed25519 signature over the UTF-8 bytes of text. */
  sign(text) {
    return b64url(nacl.sign.detached(utf8(text), this.signSecret));
  }

  /** Encrypt to a partner's Ed25519 key. Returns the envelope as JSON text. */
  seal(recipientKey, plaintext) {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const message = typeof plaintext === "string" ? utf8(plaintext) : plaintext;
    const ct = nacl.box(message, nonce, curvePublic(recipientKey), this.curveSecret);
    return JSON.stringify({ e2ee: ENVELOPE, to: hashPrefix(recipientKey), nonce: b64url(nonce), ct: b64url(ct) });
  }

  /** Open an envelope from a partner. Returns the plaintext bytes. */
  open(senderKey, envelopeText) {
    const envelope = JSON.parse(envelopeText);
    if (!envelope || envelope.e2ee !== ENVELOPE) throw new Error("not an envelope");
    const plain = nacl.box.open(unb64url(envelope.ct), unb64url(envelope.nonce), curvePublic(senderKey), this.curveSecret);
    if (!plain) throw new Error("envelope does not open with these keys");
    return plain;
  }
}

// ------------------------------------------------------------------- client

export class AamioError extends Error {
  constructor(status, body, message) {
    super(message || `aamio answered ${status}`);
    this.name = "AamioError";
    this.status = status;
    this.body = body;
  }
}

class Presence {
  constructor(client) {
    this.client = client;
  }

  /** Publish where you can be reached, signed, for ttl seconds (5 to 120). */
  async publish({ w, tags = [], ttl = 60 }) {
    const keys = this.client.needKeys("presence");
    const body = JSON.stringify({ w, tags, ttl });
    return this.client.request("PUT", "/p/" + keys.public, { body, headers: { "X-Sig": keys.sign(presenceSigningInput(keys.public, body)) } });
  }

  /** The live record for one key, or null. */
  async get(key) {
    const data = await this.client.request("GET", "/p/" + key, { expect: [200, 404] });
    return data && data.w ? data : null;
  }

  /** Which of these keys are live now. With wait > 0 the call returns as soon as one appears. */
  async lookup(keys, { wait = 0, prefixLength = 8 } = {}) {
    const prefixes = keys.map((k) => hashPrefix(k, prefixLength));
    const path = wait > 0 ? "/p/watch" : "/p/lookup";
    const body = wait > 0 ? { prefixes, wait } : { prefixes };
    const data = await this.client.request("POST", path, { body: JSON.stringify(body) });
    return data.matches || [];
  }

  /** The address one partner is at right now, or null. */
  async find(key) {
    const matches = await this.lookup([key]);
    const match = matches.find((m) => m.key === key);
    return match ? match.w : null;
  }

  /** Withdraw your own record now instead of letting it expire. */
  async withdraw() {
    const keys = this.client.needKeys("presence");
    const body = JSON.stringify({ at: Math.floor(Date.now() / 1000) });
    return this.client.request("DELETE", "/p/" + keys.public, { body, headers: { "X-Sig": keys.sign(presenceDeleteSigningInput(keys.public, body)) } });
  }
}

export class Aamio {
  constructor({ base = DEFAULT_BASE, keys = null, fetch = globalThis.fetch } = {}) {
    this.base = base.replace(/\/+$/, "");
    this.keys = keys;
    this.fetch = fetch;
    this.presence = new Presence(this);
  }

  needKeys(what) {
    if (!this.keys) throw new Error(what + " needs keys: new Aamio({ keys: Keys.generate() })");
    return this.keys;
  }

  async request(method, path, { body, headers = {}, expect = [200, 201] } = {}) {
    const init = { method, headers: { Accept: "application/json", ...headers } };
    if (body !== undefined) {
      init.body = body;
      if (!init.headers["Content-Type"]) init.headers["Content-Type"] = "application/json";
    }
    const response = await this.fetch(this.base + path, init);
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!expect.includes(response.status)) {
      throw new AamioError(response.status, data, (data && data.error) || `aamio answered ${response.status}`);
    }
    return data;
  }

  /**
   * Open a thread. The read key is made here and never sent anywhere but the
   * X-Read header. ttl in seconds (30 to 3600, default 600), allow a list of
   * signer keys that alone may write.
   */
  async open({ ttl, allow } = {}) {
    const id = newId();
    const w = deriveAddress(id);
    const headers = { "X-Read": id };
    if (ttl) headers["X-TTL"] = String(ttl);
    if (allow && allow.length) headers["X-Allow"] = allow.join(",");
    const data = await this.request("PUT", "/" + w, { headers });
    return { id, w, expireAt: data.expire_at, allow: data.allow || [] };
  }

  /**
   * Write to an address. body is text or a JSON value. Signed with your key by
   * default when you have one. With encryptTo, the body is sealed to that
   * partner's key first and aamio sees only the envelope.
   */
  async send(w, body, { sign = Boolean(this.keys), encryptTo = null } = {}) {
    let text = typeof body === "string" ? body : JSON.stringify(body);
    let contentType = typeof body === "string" ? "text/plain; charset=utf-8" : "application/json";
    if (encryptTo) {
      text = this.needKeys("encryption").seal(encryptTo, text);
      contentType = "application/json";
    }
    const headers = { "Content-Type": contentType };
    if (sign) {
      const keys = this.needKeys("signing");
      headers["X-Key"] = keys.public;
      headers["X-Sig"] = keys.sign(threadSigningInput(w, text));
    }
    return this.request("POST", "/" + w, { body: text, headers });
  }

  /** Read a thread you own. after: return messages with seq above it. wait: seconds, up to 25. */
  async read(thread, { after = 0, wait = 0 } = {}) {
    let path = "/" + thread.w;
    if (after > 0 || wait > 0) path += "/after/" + after;
    if (wait > 0) path += "/wait/" + wait;
    const data = await this.request("GET", path, { headers: { "X-Read": thread.id } });
    data.messages = (data.messages || []).map((m) => this.decode(m));
    return data;
  }

  /**
   * One stored message, decoded: plain is the text (decrypted when it was an
   * envelope to you), json the parsed value when the text is JSON, encrypted
   * whether it came sealed, error when it could not be opened.
   */
  decode(message) {
    const out = { ...message, encrypted: false, plain: message.body, json: undefined, error: undefined };
    if (isEnvelope(message.body)) {
      out.encrypted = true;
      out.plain = null;
      if (!this.keys) out.error = "encrypted message and this client has no keys";
      else if (!message.from || !message.verified) out.error = "encrypted message without a verified sender";
      else {
        try {
          out.plain = textDecoder.decode(this.keys.open(message.from, message.body));
        } catch {
          out.error = "envelope does not open with these keys";
        }
      }
    }
    if (typeof out.plain === "string") {
      try {
        out.json = JSON.parse(out.plain);
      } catch {
        out.json = undefined;
      }
    }
    return out;
  }

  /**
   * Yield messages as they arrive, long polling with wait seconds per call,
   * until signal aborts or the thread answers 410 (then AamioError is thrown).
   */
  async *listen(thread, { after = 0, wait = 25, signal } = {}) {
    let seq = after;
    while (!(signal && signal.aborted)) {
      const data = await this.read(thread, { after: seq, wait });
      for (const message of data.messages) {
        if (message.seq > seq) seq = message.seq;
        yield message;
      }
    }
  }

  /** The receipt of a thread you own, with its root recomputed locally. */
  async receipt(thread) {
    const receipt = await this.request("GET", "/" + thread.w + "/receipt", { headers: { "X-Read": thread.id } });
    const root = receiptRoot(receipt);
    return { receipt, root, matches: root === receipt.root, commitment: receipt.commitment };
  }

  /** Close a thread you own now instead of waiting for its expiry. */
  async close(thread) {
    return this.request("DELETE", "/" + thread.w, { headers: { "X-Read": thread.id } });
  }

  /**
   * Anchor a receipt's commitment on Solana through Verifyum, no account
   * needed. Pass the object receipt() returned, or a commitment string
   * "sha256:<root>". Returns the proof id and its public page.
   */
  async anchor(receiptOrCommitment, { endpoint = VERIFYUM_MCP, idempotencyKey } = {}) {
    const commitment = typeof receiptOrCommitment === "string" ? receiptOrCommitment : receiptOrCommitment.commitment || "sha256:" + receiptOrCommitment.root;
    const idem = idempotencyKey || sha256hex("aamio-js:" + commitment).slice(0, 32);
    const response = await this.fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "verifyum_anchor_commitment", arguments: { commitment, idempotency_key: idem } } }),
    });
    const rpc = await response.json();
    let result = {};
    try {
      result = JSON.parse(rpc?.result?.content?.[0]?.text ?? "{}");
    } catch {
      result = {};
    }
    if (rpc?.result?.isError || !result.proof_id) throw new AamioError(response.status, rpc, "anchor failed");
    return { proofId: result.proof_id, proofUrl: result.proof_url, status: result.status, commitment };
  }

  /** The current state of a Verifyum proof: status, network, transaction signature. */
  async proof(proofId, { base = VERIFYUM_API } = {}) {
    const response = await this.fetch(base + "/v2/proofs/" + proofId, { headers: { Accept: "application/json" } });
    return response.json();
  }
}
