// aamio as the runtime sees it, in memory, through a fetch of its own: threads with read keys, allowlists and
// signatures, and presence. Enough of the wire contract (https://aamio.at/api.md) for the runtime's tests, and
// no more: the real service is what code/php/tools/check-node-exchange.py runs against.
import { deriveAddress, isEnvelope, keyHash, presenceSigningInput, sha256hex, threadSigningInput, verify } from "../src/aamio.js";

export class FakeAamio {
  constructor({ now = 1_800_000_000 } = {}) {
    this.time = now;
    this.threads = new Map();
    this.presence = new Map();
    this.failures = [];
    this.requests = [];
    // Presence answers its matches in this order, or the other way round.
    this.reverseLookup = false;
    this.fetch = (url, init = {}) => {
      const where = new URL(url);
      this.requests.push(`${init.method || "GET"} ${where.pathname}`);
      return this.answer(where, init);
    };
  }

  /** The next write answers with this status, or with no answer at all for "network". */
  failNext(what) {
    this.failures.push(what);
  }

  /** The service lost its store: the thread at w is gone, and a write there opens one with no allowlist. */
  forget(w) {
    this.threads.delete(w);
  }

  reply(status, body, headers = {}) {
    return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  }

  header(init, name) {
    const headers = init.headers || {};
    const found = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    return found === undefined ? undefined : String(headers[found]);
  }

  thread(w, { id = null, ttl = 600, allow = [] } = {}) {
    const thread = { id, w, expire_at: this.time + ttl, allow, created_at: this.time, messages: [] };
    this.threads.set(w, thread);
    return thread;
  }

  async answer(url, init) {
    const method = init.method || "GET";
    const body = typeof init.body === "string" ? init.body : "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "p") return this.presenceAnswer(method, parts, body, init);
    const w = parts[0];
    if (method === "PUT" && parts.length === 1) {
      const id = this.header(init, "X-Read");
      if (!id || deriveAddress(id) !== w) return this.reply(400, { error: "X-Read does not derive this address", fix: "Make w from the read key." });
      const allow = (this.header(init, "X-Allow") || "").split(",").map((key) => key.trim()).filter(Boolean);
      const thread = this.thread(w, { id, ttl: Number(this.header(init, "X-TTL") || 600), allow: allow.includes("*") ? ["*"] : allow });
      return this.reply(201, { w, expire_at: thread.expire_at, allow: thread.allow });
    }
    if (method === "GET" && parts[1] === "gate") return this.reply(200, {});
    if (method === "POST" && parts.length === 1) {
      const failure = this.failures.shift();
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure) return this.reply(failure, { error: `the test asked for ${failure}`, fix: "none" });
      const thread = this.threads.get(w) ?? this.thread(w);
      const key = this.header(init, "X-Key");
      const sig = this.header(init, "X-Sig");
      const verified = Boolean(key && sig && verify(key, threadSigningInput(w, body), sig));
      if (key && !verified) return this.reply(400, { error: "X-Sig does not verify", fix: "Sign the exact bytes you send." });
      if (thread.allow.length && !(verified && (thread.allow.includes("*") || thread.allow.includes(key)))) {
        return this.reply(403, { error: "this inbox takes writes from listed keys only", fix: "Ask its owner to add your key." });
      }
      const message = { seq: thread.messages.length + 1, at: this.time, body, sha256: sha256hex(body), from: verified ? key : null, verified, sealed: isEnvelope(body) };
      if (verified) message.sig = sig;
      thread.messages.push(message);
      return this.reply(201, { seq: message.seq, at: message.at, sha256: message.sha256, expire_at: thread.expire_at, verified });
    }
    if (method === "GET") {
      const thread = this.threads.get(w);
      if (!thread) return this.reply(200, { exists: false, messages: [], next: 0 });
      if (thread.id !== null && this.header(init, "X-Read") !== thread.id) return this.reply(403, { error: "wrong read key", fix: "Read with the key the thread was opened with." });
      const after = parts[1] === "after" ? Number(parts[2]) : 0;
      const limit = Number(this.header(init, "X-Limit") || 0);
      let messages = thread.messages.filter((m) => m.seq > after);
      if (limit) messages = messages.slice(0, limit);
      const next = messages.length ? messages[messages.length - 1].seq : after;
      return this.reply(200, { exists: true, created_at: thread.created_at, expire_at: thread.expire_at, messages: messages.map((m) => ({ ...m })), next });
    }
    return this.reply(404, { error: "not in the fake", fix: "none" });
  }

  presenceAnswer(method, parts, body, init) {
    if (method === "PUT" && parts.length === 2) {
      const key = parts[1];
      if (!verify(key, presenceSigningInput(key, body), this.header(init, "X-Sig") || "")) return this.reply(400, { error: "X-Sig does not verify", fix: "Sign the body." });
      const record = JSON.parse(body);
      this.presence.set(key, { key, hash: keyHash(key), w: record.w, tags: record.tags, expire_at: this.time + record.ttl });
      return this.reply(200, { ok: true });
    }
    if (method === "POST" && (parts[1] === "lookup" || parts[1] === "watch")) {
      const { prefixes } = JSON.parse(body);
      const matches = [...this.presence.values()].filter((r) => r.expire_at > this.time && prefixes.some((p) => r.hash.startsWith(p)));
      return this.reply(200, { matches: this.reverseLookup ? matches.reverse() : matches });
    }
    return this.reply(404, { error: "not in the fake", fix: "none" });
  }
}
