// aamio as the runtime sees it, in memory, through a fetch of its own: threads with read keys, allowlists and
// signatures, presence, and the board at BOARD. Enough of the wire contract (https://aamio.at/api.md) for the
// runtime's tests, and no more: the real service is what code/php/tools/check-node-exchange.py runs against.
import { randomBytes } from "node:crypto";
import { boardDeleteSigningInput, boardSigningInput, deriveAddress, isEnvelope, keyHash, presenceSigningInput, scopeAddress, sha256hex, threadSigningInput, verify } from "../src/aamio.js";

export const BOARD = "https://fake.board";
// Verifyum's MCP endpoint in memory: each anchoring is counted in anchors, and answered with a proof.
export const VERIFYUM = "https://fake.verifyum/mcp";

/**
 * A message as the service hands it out and measures it against a byte budget
 * (aamio_thread_public_message in func_aamio_thread.php): these fields in this
 * order, counted in UTF-8 bytes. The length of the JavaScript string counted
 * an emoji as two and let through what the service holds back.
 */
export function publicBytes(m) {
  let type = "text";
  try {
    JSON.parse(m.body);
    type = "json";
  } catch {
    type = "text";
  }
  const row = { seq: m.seq, at: m.at, type, body: m.body, sha256: m.sha256, from: m.from ?? null, sig: m.sig ?? null, verified: m.from != null, sealed: Boolean(m.sealed) };
  return Buffer.byteLength(JSON.stringify(row), "utf8");
}

export class FakeAamio {
  constructor({ now = 1_800_000_000 } = {}) {
    this.time = now;
    this.threads = new Map();
    this.presence = new Map();
    this.failures = [];
    this.requests = [];
    this.posts = new Map();
    this.boardSeq = 0;
    // What the board's descriptor advises posts to carry.
    this.boardBits = 0;
    // Scopes on the board (func_aamio_board.php): a post that carries a scope's address is unlisted, and only a find
    // with the key that address was derived from returns it. finds keeps the body of every find, so a test can see
    // where a key went. A page holds boardPage posts, the oldest of what is new. boardScopeEcho is what a find of a
    // scope names as the scope it read: the address when nothing is set, nothing at all for false, or what a test
    // says. boardKnowsNoScopes plays a board from before scopes, and boardFailures answers the next finds as told.
    this.finds = [];
    this.boardPage = 200;
    this.boardScopeEcho = undefined;
    this.boardKnowsNoScopes = false;
    this.boardFailures = [];
    // Presence answers its matches in this order, or the other way round.
    this.reverseLookup = false;
    // The arguments of every anchoring Verifyum was asked for, and what the receipt route hands out, changed if a test says so.
    this.anchors = [];
    this.tamperReceipt = null;
    // The byte budget each thread read asked for, in order: null for none. With
    // ignoreBudget the header is recorded and nothing else is done with it, as a
    // service without read limits answers.
    this.budgets = [];
    this.ignoreBudget = false;
    // A service that does not take X-Limit either, and sends every row after the cursor.
    this.ignoreLimit = false;
    // A service from before instances: no thread is named by one.
    this.noInstance = false;
    this.fetch = (url, init = {}) => {
      const where = new URL(url);
      if (where.host === new URL(VERIFYUM).host) return this.anchorAnswer(init);
      this.requests.push(`${init.method || "GET"} ${where.host === new URL(BOARD).host ? "board" : ""}${where.pathname}`);
      return where.host === new URL(BOARD).host ? this.boardAnswer(where, init) : this.answer(where, init);
    };
  }

  /**
   * The next write answers with this status, or with no answer at all: for
   * "network" nothing is stored, and for "lost" the message is stored and the
   * answer never arrives, which is the write that leaves a sender not knowing.
   */
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
    // Each thread an instance of its own, as the service gives it (aamio_thread_instance), unless the test service
    // plays one from before instances.
    const instance = this.noInstance ? undefined : randomBytes(10).toString("hex").slice(0, 16);
    const thread = { id, w, expire_at: this.time + ttl, allow, created_at: this.time, messages: [], instance };
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
      return this.reply(201, { w, expire_at: thread.expire_at, allow: thread.allow, instance: thread.instance });
    }
    if (method === "GET" && parts[1] === "gate") return this.reply(200, {});
    if (method === "POST" && parts.length === 1) {
      const failure = this.failures.shift();
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure && failure !== "lost") return this.reply(failure, { error: `the test asked for ${failure}`, fix: "none" });
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
      if (failure === "lost") throw new TypeError("fetch failed");
      return this.reply(201, { seq: message.seq, at: message.at, sha256: message.sha256, expire_at: thread.expire_at, verified });
    }
    if (method === "GET" && parts[1] === "receipt") {
      // The service's account of the thread: one line per message, and the root of the lines.
      const thread = this.threads.get(w);
      if (!thread) return this.reply(404, { error: "no thread at this address", fix: "Take the receipt before the thread expires." });
      if (thread.id !== null && this.header(init, "X-Read") !== thread.id) return this.reply(403, { error: "wrong read key", fix: "Read with the key the thread was opened with." });
      const messages = thread.messages.map((m) => ({ seq: m.seq, at: m.at, sha256: m.sha256, from: m.from }));
      const root = sha256hex(messages.map((m) => `${m.seq}\t${m.at}\t${m.sha256}\t${m.from ?? "-"}\n`).join(""));
      const receipt = {
        schema: "aamio-receipt-v1", w, instance: thread.instance, created_at: thread.created_at, expire_at: thread.expire_at, count: messages.length,
        bytes: thread.messages.reduce((sum, m) => sum + m.body.length, 0), allow: thread.allow, messages,
        keys: [...new Set(messages.map((m) => m.from).filter(Boolean))], root, commitment: "sha256:" + root, issued_at: this.time,
      };
      return this.reply(200, this.tamperReceipt ? this.tamperReceipt(receipt) : receipt);
    }
    if (method === "GET") {
      const thread = this.threads.get(w);
      let after = parts[1] === "after" ? Number(parts[2]) : 0;
      // A cursor sent to an address with no thread, or past the last message of the one there, is from an earlier
      // thread at this address: the service says reset, and reads from the start (func_aamio_thread.php).
      if (!thread) return this.reply(200, { exists: false, messages: [], next: 0, ...(after > 0 ? { reset: { after, newest: 0, what: "The cursor sent was for a thread that is not here now, so next is 0: a thread that opens here starts again at one." } } : {}) });
      if (thread.id !== null && this.header(init, "X-Read") !== thread.id) return this.reply(403, { error: "wrong read key", fix: "Read with the key the thread was opened with." });
      let reset = null;
      if (after > thread.messages.length) {
        reset = { after, newest: thread.messages.length, what: `after ${after} is past the last message this thread holds, ${thread.messages.length}, so the cursor is from an earlier thread at this address. This answer reads from the start, and next is the cursor to keep.` };
        after = 0;
      }
      const limit = this.ignoreLimit ? 0 : Number(this.header(init, "X-Limit") || 0);
      const asked = this.header(init, "X-Max-Bytes");
      // Checked as the service checks it (blocks/api-thread.php): one to eight digits, at least 512.
      if (!this.ignoreBudget && asked !== undefined && (!/^[0-9]{1,8}$/.test(asked) || Number(asked) < 512)) {
        return this.reply(400, { error: "Bad X-Max-Bytes", fix: "a whole number of bytes, at least 512." });
      }
      this.budgets.push(asked === undefined ? null : Number(asked));
      const budget = this.ignoreBudget || asked === undefined ? null : Number(asked);
      let messages = thread.messages.filter((m) => m.seq > after);
      // More than the count asked for is said with more, as the service says it (func_aamio_thread.php).
      let more = false;
      if (limit && messages.length > limit) {
        messages = messages.slice(0, limit);
        more = true;
      }
      // Whole messages only, as the service answers a byte budget: what does not fit stays, said with more, and a
      // first message larger than the whole budget is named in too_large with the cursor where it was.
      let tooLarge = null;
      if (budget !== null) {
        const kept = [];
        let used = 0;
        for (const m of messages) {
          const size = publicBytes(m);
          if (used + size > budget) {
            if (!kept.length) tooLarge = { seq: m.seq, bytes: size, fix: "Read with a bigger budget, or pass its seq as after to go past it." };
            more = true;
            break;
          }
          kept.push(m);
          used += size;
        }
        messages = kept;
      }
      const next = messages.length ? messages[messages.length - 1].seq : after;
      const answer = { exists: true, created_at: thread.created_at, expire_at: thread.expire_at, instance: thread.instance, messages: messages.map((m) => ({ ...m })), next };
      if (more) answer.more = true;
      if (tooLarge) answer.too_large = tooLarge;
      if (reset) answer.reset = reset;
      return this.reply(200, answer);
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

  /** The board: posts signed by their key, pointing at a live inbox open to any signed key, found by kind, tag and cursor. */
  boardAnswer(url, init) {
    const method = init.method || "GET";
    const body = typeof init.body === "string" ? init.body : "";
    const path = url.pathname;
    const live = [...this.posts.values()].filter((post) => post.expire_at > this.time);
    if (method === "GET" && path === "/.well-known/aamio-board.json") return this.reply(200, { work: { advise_bits: this.boardBits } });
    if (method === "POST" && path === "/") {
      const key = this.header(init, "X-Key");
      if (!key || !verify(key, boardSigningInput(key, body), this.header(init, "X-Sig") || "")) return this.reply(400, { error: "X-Sig does not verify", fix: "Sign aamio-board-v1, the key and the sha256 of the body." });
      const fields = JSON.parse(body);
      if (!["need", "offer"].includes(fields.kind)) return this.reply(400, { error: "kind is need or offer", fix: "Say need or offer." });
      const thread = this.threads.get(fields.w);
      if (!thread || thread.expire_at < this.time + fields.ttl || !(thread.allow.length === 0 || thread.allow.includes("*"))) {
        return this.reply(409, { error: "a post whose address is dead reaches nobody", field: "w", fix: "Open the inbox with X-Allow: * for longer than the post." });
      }
      if ("scope" in fields && (this.boardKnowsNoScopes || typeof fields.scope !== "string" || !/^[a-z2-7]{20}$/.test(fields.scope))) {
        return this.reply(400, { error: "scope is the 20 character address of a scope", field: "scope", fix: "Derive the address from the key, and leave the field out for a public post." });
      }
      const id = sha256hex(key + body).slice(0, 20);
      const post = { id, key, kind: fields.kind, title: fields.title, text: fields.text, w: fields.w, tags: fields.tags ?? [], lang: fields.lang ?? null, seq: ++this.boardSeq, created_at: this.time, expire_at: this.time + fields.ttl, work_bits: this.header(init, "X-Work") ? this.boardBits : 0 };
      // Only on a post in a scope, and only ever seen by a find with that scope's key.
      if (fields.scope) post.scope = fields.scope;
      this.posts.set(id, post);
      return this.reply(201, { ...post });
    }
    if (method === "POST" && path === "/find") {
      const filter = body ? JSON.parse(body) : {};
      this.finds.push(filter);
      const failure = this.boardFailures.shift();
      if (failure) return this.reply(failure.status, typeof failure.body === "function" ? failure.body(filter) : failure.body);
      if ("scope" in filter) return this.reply(400, { error: "Reading a scope takes scope_key, not scope", fix: "Send the scope key the address was derived from as scope_key." });
      let scope = null;
      if ("scope_key" in filter) {
        if (this.boardKnowsNoScopes) return this.reply(400, { error: "Unknown field scope_key. The form is kind, tags, lang, key, after, wait, min_work_bits", fix: "Leave the field out." });
        if (typeof filter.scope_key !== "string" || !/^[a-z0-9]{26,64}$/.test(filter.scope_key)) return this.reply(400, { error: "scope_key must be 26 to 64 characters of a-z and 0-9", fix: "Send the scope key itself, and not the 20 character address that goes on a post." });
        // The key only ever becomes the address here.
        scope = scopeAddress(filter.scope_key);
      }
      const covers = (tag) => (filter.tags ?? []).some((wanted) => tag === wanted || tag.startsWith(wanted + "."));
      // One part of the board: the public one, or one scope. Never both.
      const matching = live.filter((post) => (post.scope ?? null) === scope && (!filter.kind || post.kind === filter.kind) && (!filter.tags?.length || post.tags.some(covers))
        && (!filter.lang || post.lang === filter.lang) && post.work_bits >= (filter.min_work_bits ?? 0));
      // Newest first, and a page holds the oldest of what is new, so a caller that follows next steps over nothing.
      const fresh = matching.filter((post) => post.seq > (filter.after ?? 0)).reverse();
      const more = fresh.length > this.boardPage;
      const posts = more ? fresh.slice(-this.boardPage) : fresh;
      const answer = { count: posts.length, live: matching.length, next: posts.reduce((highest, post) => Math.max(highest, post.seq), filter.after ?? 0), more, posts };
      // The answer names the scope it read.
      if (scope !== null && this.boardScopeEcho !== false) answer.scope = this.boardScopeEcho ?? scope;
      return this.reply(200, answer);
    }
    if (method === "GET" && path === "/tags") {
      const tags = {};
      for (const post of live.filter((p) => !p.scope)) for (const tag of post.tags) {
        tags[tag] ??= { tag, needs: 0, offers: 0 };
        tags[tag][post.kind === "need" ? "needs" : "offers"]++;
      }
      return this.reply(200, { tags: Object.values(tags) });
    }
    const id = decodeURIComponent(path.slice(1));
    const post = live.find((p) => p.id === id);
    // A post in a scope is never served by its id: only a find with the scope's key returns it.
    if (method === "GET") return post && !post.scope ? this.reply(200, { ...post }) : this.reply(404, { error: "no live post with that id", id });
    if (method === "DELETE") {
      if (!post) return this.reply(404, { error: "no live post with that id", id });
      if (!verify(post.key, boardDeleteSigningInput(id, body), this.header(init, "X-Sig") || "")) return this.reply(403, { error: "only the key that posted can withdraw", fix: "Sign with that key." });
      this.posts.delete(id);
      return this.reply(200, { withdrawn: true, id });
    }
    return this.reply(404, { error: "not on the fake board", fix: "none" });
  }

  /** Verifyum's anchoring tool: the commitment and the idempotency key are kept, and a proof is given. */
  anchorAnswer(init) {
    const call = JSON.parse(typeof init.body === "string" ? init.body : "{}");
    const args = call.params?.arguments ?? {};
    this.anchors.push(args);
    const proof = { proof_id: "proof-" + String(args.idempotency_key).slice(0, 8), proof_url: "https://fake.verifyum/p/" + args.idempotency_key, status: "pending" };
    return this.reply(200, { jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: JSON.stringify(proof) }], isError: false } });
  }
}
