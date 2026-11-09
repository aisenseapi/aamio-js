import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { Keys } from "../src/aamio.js";
import { serveMcp } from "../src/node-mcp.js";

const MODERN = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": MODERN };
const request = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });
const line = (message) => JSON.stringify(message) + "\n";

async function exchange(chunks, home) {
  let text = "";
  const output = new Writable({
    write(chunk, encoding, callback) { text += chunk.toString("utf8"); callback(); },
  });
  await serveMcp({ home, version: "0.0.0-test", input: Readable.from(chunks), output });
  if (!text) return [];
  assert.ok(text.endsWith("\n"), "stdio replies end in a newline");
  return text.trimEnd().split("\n").map((entry) => JSON.parse(entry));
}

test("Node MCP negotiates old and modern wires and advertises only the public identity tool", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "aamio-mcp-"));
  t.after(() => rm(base, { force: true, recursive: true }));
  const home = join(base, "missing");
  const [discovery, modernList, oldInit, empty, modernInit, inherited, oldOverride] = await exchange([
    line(request(1, "server/discover")),
    line(request(2, "tools/list", { _meta: META })),
    line(request(3, "initialize", { protocolVersion: "2025-11-25" })),
    line(request(4, "ping")),
    line(request(5, "initialize", { protocolVersion: MODERN })),
    line(request(6, "ping")),
    line(request(7, "resources/templates/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-03-26" } })),
  ], home);
  assert.equal(discovery.result.resultType, "complete");
  assert.equal(discovery.result._meta["io.modelcontextprotocol/serverInfo"].version, "0.0.0-test");
  assert.ok(discovery.result.supportedVersions.includes(MODERN));
  assert.deepEqual(modernList.result.tools.map(({ name }) => name), ["aamio_whoami"]);
  assert.equal(modernList.result.resultType, "complete");
  assert.equal(modernList.result.cacheScope, "public");
  assert.deepEqual(oldInit.result.capabilities, { tools: { listChanged: false } });
  assert.ok(!("resultType" in oldInit.result));
  assert.deepEqual(empty.result, {});
  assert.equal(modernInit.result.protocolVersion, MODERN);
  assert.deepEqual(inherited.result, { resultType: "complete" });
  assert.deepEqual(oldOverride.result, { resourceTemplates: [] });
  await assert.rejects(access(home), { code: "ENOENT" });
});

test("Node MCP returns only the public identity and keeps failed calls free of private input", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "aamio-mcp-"));
  t.after(() => rm(base, { force: true, recursive: true }));
  const home = join(base, "home");
  const call = request(1, "tools/call", { name: "aamio_whoami", arguments: {}, _meta: META });
  const [missing] = await exchange([line(call)], home);
  assert.equal(missing.result.isError, true);
  assert.equal(missing.result.structuredContent.error, "home_not_initialized");
  await assert.rejects(access(home), { code: "ENOENT" });

  await mkdir(home, { mode: 0o700 });
  const seed = "71".repeat(32);
  await writeFile(join(home, "key"), seed + "\n", { mode: 0o600 });
  const keys = Keys.fromSeedHex(seed);
  const [identity] = await exchange([line(call)], home);
  const publicIdentity = { key: keys.public, hash: keys.hash, hash_prefix: keys.hash.slice(0, 8) };
  assert.equal(identity.result.resultType, "complete");
  assert.equal(identity.result.isError, false);
  assert.deepEqual(identity.result.structuredContent, publicIdentity);
  assert.deepEqual(JSON.parse(identity.result.content[0].text), publicIdentity);
  assert.ok(!JSON.stringify(identity).includes(seed));

  const canary = "secret test value which must never be echoed";
  await writeFile(join(home, "key"), canary);
  const replies = await exchange([
    line(call), line(request(2, "tools/call", { name: canary })),
    line(request(3, "tools/call", { name: "aamio_whoami", arguments: { extra: canary } })),
    line(request(4, "tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": canary } })),
    line(request(5, "ping")),
  ], home);
  assert.equal(replies[0].result.structuredContent.error, "key_unreadable");
  assert.deepEqual(replies.slice(1, 4).map((r) => r.error.code), [-32602, -32602, -32022]);
  assert.deepEqual(replies[4].result, {});
  assert.ok(!JSON.stringify(replies).includes(canary));
});

test("Node MCP handles split UTF-8, batches, notifications and oversized lines without losing the next request", async () => {
  const first = Buffer.from(line(request("møte", "ping")).replace("\n", "\r\n"));
  const split = first.indexOf(Buffer.from("ø")) + 1;
  const replies = await exchange([
    first.subarray(0, split), first.subarray(split), "\n",
    "{\n", Buffer.from([0xff, 10]), "oversized ", Buffer.alloc(65_536, 32), "discard\n",
    line({ jsonrpc: "2.0", method: "notifications/initialized" }),
    line({ jsonrpc: "2.0", id: 9, result: {} }),
    line([request(1, "ping"), { jsonrpc: "2.0", method: "ping" }, request(2, "missing")]),
    line([]), JSON.stringify(request(3, "ping")),
  ]);
  assert.equal(replies[0].id, "møte");
  assert.deepEqual(replies.slice(1, 4).map((r) => r.error.code), [-32700, -32700, -32600]);
  assert.deepEqual(replies[4].map((r) => r.id), [1, 2]);
  assert.equal(replies[4][1].error.code, -32601);
  assert.equal(replies[5].error.code, -32600);
  assert.equal(replies[6].id, 3);
  assert.equal(replies.length, 7);
});

test("Node MCP replies to each client request while stdin is still open", { timeout: 3000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const serving = serveMcp({ version: "test", input, output });
  try {
    for (const id of [1, 2]) {
      const response = once(output, "data");
      input.write(line(request(id, "ping")));
      const [chunk] = await response;
      assert.deepEqual(JSON.parse(chunk), { jsonrpc: "2.0", id, result: {} });
    }
  } finally {
    input.end();
    await serving;
  }
});
