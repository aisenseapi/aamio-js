// Reading a domain key list from the domain: what reaches the network, and what comes back.
//
// The resolver and the connection are fakes that answer as told and record what they were asked, so every rule is
// tried without a network: only public addresses, the checked address and no second lookup, no redirect or retry,
// nothing about the reader in the request, the limits, and an answer for every way it can go. The addresses come
// from domain_fetch_vectors.json, which every client that reads lists over the network shares. The cases are the
// ones aamio-python tries in tests/test_domain_fetch.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { ADDRESS_POLICY, DENIED_NETWORKS, IPV6_GLOBAL, MAX_HEADER_BYTES, check, parseNetwork, publicAddress } from "../src/fetch.js";
import { makeDomainKeys } from "../src/lists.js";

const VECTORS = JSON.parse(readFileSync(new URL("./domain_fetch_vectors.json", import.meta.url), "utf8"));
const KEY = "c3lrmIg_bOnE-fQyMRpxvqoeXAhkBGqDHCD9LXKWSnc";
const OTHER = "wK1BJa9cuHn7Y7QPC_4EQ6X_jtCbgbMbR6pqT-VGmmA";
const PUBLIC = "93.184.216.34";
const WHEN = new Date(Date.UTC(2026, 10, 7, 12, 0, 0));
const LIST = Buffer.from(makeDomainKeys([{ key: KEY, name: "support" }]));

function http(status = 200, headers = null, body = LIST) {
  const reason = { 200: "OK", 404: "Not Found" }[status] ?? "X";
  const lines = Object.entries(headers ?? { "Content-Type": "application/json; charset=utf-8" }).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  return Buffer.concat([Buffer.from(`HTTP/1.1 ${status} ${reason}\r\n${lines}\r\n`, "latin1"), body]);
}

class Connection {
  constructor(chunks, onRead = null) {
    this.chunks = [...chunks];
    this.sent = Buffer.alloc(0);
    this.closed = false;
    this.reads = 0;
    this.onRead = onRead;
  }

  async write(bytes) {
    this.sent = Buffer.concat([this.sent, bytes]);
  }

  async read(seconds) {
    assert.ok(seconds > 0);
    this.reads += 1;
    this.onRead?.();
    if (!this.chunks.length) return null;
    const chunk = this.chunks.shift();
    if (chunk instanceof Error) throw chunk;
    return chunk;
  }

  close() {
    this.closed = true;
  }
}

const timeout = () => Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
const refusedConnection = () => Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
const certificate = () => Object.assign(new Error("certificate"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });

async function run(chunks, { addresses = [PUBLIC], domain = "example.org", key = KEY, name = null, connectErrors = [], ...options } = {}) {
  const seen = { resolved: [], connected: [] };
  const connection = new Connection(chunks);
  const failures = [...connectErrors];
  const resolve = async (host) => {
    seen.resolved.push(host);
    return [...addresses];
  };
  const connect = async (address, host, remaining) => {
    seen.connected.push([address, host]);
    assert.ok(remaining > 0);
    if (failures.length) {
      const failure = failures.shift();
      if (failure) throw failure;
    }
    return connection;
  };
  const result = await check(domain, key, name, { resolve, connect, now: () => WHEN, ...options });
  return [result, connection, seen];
}

test("a listed key, with what was read and when", async () => {
  const [result, connection, seen] = await run([http()], { name: "support" });
  assert.deepEqual(result, {
    domain: "example.org", key: KEY, checked_at: "2026-11-07T12:00:00Z", requested_name: "support", status: "listed", reason: "key_listed",
    document_sha256: result.document_sha256, matched_name: "support",
  });
  assert.match(result.document_sha256, /^[0-9a-f]{64}$/);
  assert.equal(connection.closed, true);
  assert.deepEqual(seen, { resolved: ["example.org"], connected: [[PUBLIC, "example.org"]] });
});

test("the request names the host and the path, and nothing about the reader", async () => {
  const [, connection] = await run([http()], { domain: "Example.ORG", name: "support" });
  assert.equal(connection.sent.toString("latin1"), "GET /.well-known/aamio-keys.json HTTP/1.0\r\nHost: example.org\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nUser-Agent: aamio-domain-keys/1\r\nConnection: close\r\n\r\n");
  assert.equal(connection.sent.includes(KEY) || connection.sent.includes("support"), false);
});

test("a key that is not there, and a name it is not under", async () => {
  const [absent] = await run([http()], { key: OTHER });
  assert.deepEqual([absent.status, absent.reason, "matched_name" in absent, /^[0-9a-f]{64}$/.test(absent.document_sha256)], ["not_listed", "key_or_name_not_listed", false, true]);
  const [other] = await run([http()], { name: "billing" });
  assert.deepEqual([other.status, other.reason, other.requested_name], ["not_listed", "key_or_name_not_listed", "billing"]);
});

test("a list that is not version 1 is invalid, and lists nothing", async () => {
  const body = Buffer.from(JSON.stringify({ aamio_keys: 2, keys: [{ key: KEY }] }));
  const [result] = await run([http(200, null, body)]);
  assert.deepEqual([result.status, result.reason, result.detail], ["invalid", "invalid_document", "unsupported_version"]);
});

test("every other status is its own answer: no list, a redirect that is never followed, and no answer at all", async () => {
  for (const status of [404, 410]) {
    const [result] = await run([http(status, {}, Buffer.alloc(0))]);
    assert.deepEqual([result.status, result.reason, result.http_status], ["no_list", "no_list", status]);
  }
  for (const status of [300, 301, 302, 303, 307, 308]) {
    const [result, , seen] = await run([http(status, { Location: "https://elsewhere.example/.well-known/aamio-keys.json" }, Buffer.alloc(0))]);
    assert.deepEqual([result.status, result.reason, result.http_status], ["invalid", "redirect_refused", status]);
    assert.equal(seen.connected.length, 1, "and nothing else was connected to");
  }
  for (const status of [204, 304, 401, 403, 429, 500, 502, 503]) {
    const [result] = await run([http(status, {}, Buffer.alloc(0))]);
    assert.deepEqual([result.status, result.reason, result.http_status], ["unreachable", "http_status", status], "never not_listed");
  }
});

test("only JSON is read, as it is: no login page, no compressed and no chunked body", async () => {
  for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON;charset=UTF-8", "application/json ; charset = utf-8"]) {
    assert.equal((await run([http(200, { "Content-Type": type })]))[0].status, "listed", type);
  }
  for (const type of ["text/html", "text/plain", "application/json; charset=latin1", "application/jsonp", "", "application/json; boundary=x"]) {
    const [result] = await run([http(200, { "Content-Type": type })]);
    assert.deepEqual([result.status, result.reason], ["invalid", "content_type"], type);
  }
  const [login] = await run([http(200, { "Content-Type": "text/html" }, Buffer.from("<html>log in</html>"))]);
  assert.deepEqual([login.status, login.reason], ["invalid", "content_type"]);
  for (const header of [{ "Content-Encoding": "gzip" }, { "Transfer-Encoding": "chunked" }, { "Content-Encoding": "br" }]) {
    const [result] = await run([http(200, { "Content-Type": "application/json", ...header })]);
    assert.deepEqual([result.status, result.reason], ["invalid", "content_encoding"], JSON.stringify(header));
  }
  assert.equal((await run([http(200, { "Content-Type": "application/json", "Content-Encoding": "identity", "Content-Length": String(LIST.length) })]))[0].status, "listed");
  const [short] = await run([http(200, { "Content-Type": "application/json", "Content-Length": String(LIST.length + 10) })]);
  assert.deepEqual([short.status, short.reason], ["invalid", "length_mismatch"]);
});

test("a body or headers past the limit are cut off, and never read whole", async () => {
  const chunks = [http(200, null, Buffer.alloc(0)), ...Array.from({ length: 20 }, () => Buffer.alloc(4096, 0x20))];
  const [result, connection] = await run(chunks);
  assert.deepEqual([result.status, result.reason], ["invalid", "body_limit"]);
  assert.ok(connection.reads <= 7, `read ${connection.reads} times, and stopped`);
  assert.equal(connection.closed, true);
  const head = Buffer.from("HTTP/1.1 200 OK\r\n" + ("X-Pad: " + "a".repeat(1000) + "\r\n").repeat(40), "latin1");
  const [big, bigConnection] = await run([head.subarray(0, 8192), head.subarray(8192, 16384), head.subarray(16384), Buffer.from("\r\n")]);
  assert.deepEqual([big.status, big.reason], ["invalid", "header_limit"]);
  assert.ok(bigConnection.reads <= 4);
  assert.equal(MAX_HEADER_BYTES, 16384);
});

test("what is not an answer over HTTP is said as that", async () => {
  assert.deepEqual((({ status, reason }) => [status, reason])((await run([Buffer.from("SSH-2.0-OpenSSH\r\n\r\n")]))[0]), ["invalid", "not_http"]);
  for (const status of ["20", "2000", "2x0", "²00", "200"]) {
    const [result] = await run([Buffer.from(`HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\n\r\n`, "utf8"), LIST]);
    assert.equal(result.reason, status === "200" ? "key_listed" : "not_http", status);
  }
  const [bad] = await run([Buffer.from("HTTP/1.1 200 OK\r\nno colon here\r\n\r\n")]);
  assert.deepEqual([bad.status, bad.reason], ["invalid", "bad_header"]);
  const [spaced] = await run([Buffer.from("HTTP/1.1 200 OK\r\n Content-Type: application/json\r\n\r\n")]);
  assert.equal(spaced.reason, "bad_header");
  const [closed] = await run([]);
  assert.deepEqual([closed.status, closed.reason], ["unreachable", "connection_closed"]);
  const [half] = await run([Buffer.from("HTTP/1.1 200 OK\r\nContent-")]);
  assert.deepEqual([half.status, half.reason], ["unreachable", "connection_closed"]);
});

test("the time is for everything: a slow server, and a read that times out, are no answer", async () => {
  let at = 0;
  const clock = () => at;
  const head = http(200, null, Buffer.alloc(0));
  // Each read takes two seconds of a five second limit: the third never happens.
  const connection = new Connection([head, LIST.subarray(0, 10), LIST.subarray(10), Buffer.alloc(0)], () => { at += 2; });
  const result = await check("example.org", KEY, null, { resolve: async () => [PUBLIC], connect: async () => connection, clock, now: () => WHEN });
  assert.deepEqual([result.status, result.reason], ["unreachable", "timeout"]);
  assert.equal(connection.closed, true);
  const [stalled] = await run([http(200, null, Buffer.alloc(0)), timeout()]);
  assert.deepEqual([stalled.status, stalled.reason], ["unreachable", "timeout"]);
  const [broken] = await run([http(200, null, Buffer.alloc(0)), Object.assign(new Error("reset"), { code: "ECONNRESET" })]);
  assert.deepEqual([broken.status, broken.reason], ["unreachable", "network"]);
});

test("one address that is not public refuses the whole read, before anything is connected to", async () => {
  for (const addresses of [[PUBLIC, "10.0.0.5"], ["127.0.0.1"], [PUBLIC, "::1"], ["fe80::1%eth0", PUBLIC], [PUBLIC, "not an address"]]) {
    const [result, , seen] = await run([http()], { addresses });
    assert.deepEqual([result.status, result.reason, seen.connected.length], ["invalid", "target_not_public", 0], JSON.stringify(addresses));
  }
});

test("the addresses that are never reached and the ones that are, as every client has them", () => {
  assert.equal(VECTORS.address_policy, ADDRESS_POLICY);
  assert.equal(VECTORS.ipv6_global, IPV6_GLOBAL);
  assert.deepEqual(VECTORS.denied_networks, DENIED_NETWORKS);
  for (const address of VECTORS.refused) assert.equal(publicAddress(address), false, address);
  for (const address of VECTORS.public) assert.equal(publicAddress(address), true, address);
  for (const value of [null, 7, "", "example.org", "1.2.3.4/32", " 1.2.3.4"]) assert.equal(publicAddress(value), false, String(value));
});

test("the vectors are the ones aamio-python keeps", (t) => {
  const there = new URL("../../../../aamio-python/tests/domain_fetch_vectors.json", import.meta.url);
  if (!existsSync(there)) return t.skip("no aamio-python checkout beside this one");
  assert.equal(readFileSync(there, "utf8").replaceAll("\r\n", "\n"), readFileSync(new URL("./domain_fetch_vectors.json", import.meta.url), "utf8").replaceAll("\r\n", "\n"));
});

test("the operator can keep more networks out", async () => {
  assert.equal(publicAddress(PUBLIC, ["93.184.216.0/24"]), false);
  assert.equal(publicAddress(PUBLIC, ["93.184.217.0/24", "2001:4860::/32"]), true);
  assert.equal(publicAddress("2001:4860:4860::8888", ["2001:4860::/32"]), false);
  assert.equal(publicAddress(PUBLIC, [PUBLIC]), false, "a single address is a network of one");
  const [result, , seen] = await run([http()], { deny: ["93.184.216.0/24"] });
  assert.deepEqual([result.status, result.reason, seen.connected.length], ["invalid", "target_not_public", 0]);
  for (const bad of ["", "1.2.3.4/33", "1.2.3.4/x", "::1/129", "example.org/24", "1.2.3.4/24/1", "fe80::1%eth0/64", "1.2.3/24", 7, null]) assert.equal(parseNetwork(bad), null, String(bad));
  assert.deepEqual([parseNetwork("203.0.113.0/24"), parseNetwork("2001:db8::/32"), parseNetwork("8.8.8.8")], [["203.0.113.0", 24, 4], ["2001:db8::", 32, 6], ["8.8.8.8", 32, 4]]);
});

test("the name is looked up once, and the checked address is the one connected to", async () => {
  const [result, , seen] = await run([http()], { addresses: [PUBLIC, "1.1.1.1"] });
  assert.equal(result.status, "listed");
  assert.deepEqual(seen, { resolved: ["example.org"], connected: [[PUBLIC, "example.org"]] });
});

test("the next checked address when one will not connect, and what is said when none does", async () => {
  const [result, , seen] = await run([http()], { addresses: ["2606:2800:220:1:248:1893:25c8:1946", PUBLIC], connectErrors: [refusedConnection()] });
  assert.equal(result.status, "listed");
  assert.deepEqual(seen.connected.map(([address]) => address), ["2606:2800:220:1:248:1893:25c8:1946", PUBLIC]);
  const [none] = await run([http()], { addresses: [PUBLIC, "1.1.1.1"], connectErrors: [refusedConnection(), refusedConnection()] });
  assert.deepEqual([none.status, none.reason], ["unreachable", "connect"]);
  const [slow] = await run([http()], { addresses: [PUBLIC, "1.1.1.1"], connectErrors: [timeout(), refusedConnection()] });
  assert.deepEqual([slow.status, slow.reason], ["unreachable", "timeout"]);
});

test("a certificate that does not fit stops the read, and the next address is not tried", async () => {
  const [result, , seen] = await run([http()], { addresses: [PUBLIC, "1.1.1.1"], connectErrors: [certificate()] });
  assert.deepEqual([result.status, result.reason], ["unreachable", "tls"]);
  assert.equal(seen.connected.length, 1);
});

test("each address gets its share of the time, and a silent one does not take it all", async () => {
  let at = 0;
  const shares = [];
  const connect = async (address, host, remaining) => {
    shares.push(remaining);
    // The first never answers, and uses the share it was given.
    if (shares.length === 1) {
      at += remaining;
      throw timeout();
    }
    return new Connection([http()]);
  };
  const result = await check("example.org", KEY, null, { resolve: async () => ["2606:2800:220:1:248:1893:25c8:1946", PUBLIC], connect, clock: () => at, now: () => WHEN });
  assert.equal(result.status, "listed");
  assert.deepEqual(shares, [2.5, 2.5]);
});

test("a name that does not resolve, and a lookup that takes the time", async () => {
  const failing = async (error) => check("example.org", KEY, null, { resolve: async () => { throw error; }, connect: async () => assert.fail("nothing is connected to"), now: () => WHEN });
  assert.deepEqual((({ status, reason }) => [status, reason])(await failing(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }))), ["unreachable", "dns"]);
  assert.deepEqual((({ status, reason }) => [status, reason])(await failing(timeout())), ["unreachable", "timeout"]);
  const [empty] = await run([http()], { addresses: [] });
  assert.deepEqual([empty.status, empty.reason], ["unreachable", "dns"]);
});

test("what is refused never reaches the network", async () => {
  const cases = [
    ["https://example.org", KEY, null, "invalid_domain"], ["localhost", KEY, null, "invalid_domain"], ["1.2.3.4", KEY, null, "invalid_domain"], ["example.org.", KEY, null, "invalid_domain"],
    ["example.org", "short", null, "invalid_subject_key"], ["example.org", null, null, "invalid_subject_key"], ["example.org", KEY, "Not A Label", "invalid_requested_name"],
  ];
  for (const [domain, key, name, reason] of cases) {
    const [result, , seen] = await run([http()], { domain, key, name });
    assert.deepEqual([result.status, result.reason, seen.resolved.length, seen.connected.length], ["invalid", reason, 0, 0], JSON.stringify([domain, name]));
  }
  const [other, , seen] = await run([http()], { allowed: ["other.example"] });
  assert.deepEqual([other.status, other.reason, seen.resolved.length], ["invalid", "domain_not_allowed", 0]);
  assert.equal((await run([http()], { allowed: ["example.org"] }))[0].status, "listed");
});

test("a result grants nothing: it is what was read, and when", async () => {
  const [result] = await run([http()]);
  assert.deepEqual(Object.keys(result).sort(), ["checked_at", "document_sha256", "domain", "key", "matched_name", "reason", "status"]);
});
