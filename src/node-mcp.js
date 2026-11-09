import { pipeline } from "node:stream/promises";
import { readIdentity } from "./node-identity.js";

// Keep the wire shapes in step with the Python and Composer stdio servers.
const MODERN = "2026-07-28";
const SUPPORTED = [MODERN, "2025-11-25", "2025-06-18", "2025-03-26"];
const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CACHE = { ttlMs: 3_600_000, cacheScope: "public" };
const CAPABILITIES = { tools: { listChanged: false } };
const INSTRUCTIONS = "Use aamio_whoami to read the public identity of the selected local aamio home.";
const WHOAMI = {
  name: "aamio_whoami",
  description: "Read this local home's public Ed25519 key, its SHA-256 hash and the eight-character hash prefix.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

function toolResult(data, isError) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError };
}

async function handle(message, session) {
  if (!object(message) || message.jsonrpc !== "2.0") return rpcError(null, -32600, "Invalid Request");
  const { id, method } = message;
  if (id !== undefined && typeof id !== "string" && !Number.isSafeInteger(id)) {
    return rpcError(null, -32600, "Invalid request id");
  }
  // A response to a server request and a notification do not get a reply.
  if (method === undefined && id !== undefined && ("result" in message || "error" in message)) return;
  if (typeof method !== "string") return rpcError(id ?? null, -32600, "Invalid Request");
  if (id === undefined || method.startsWith("notifications/")) return;
  const params = message.params === undefined ? {} : message.params;
  if (!object(params)) return rpcError(id, -32602, "Expected a params object");
  const named = params._meta?.[VERSION_META];
  if (named !== undefined && !SUPPORTED.includes(named)) {
    return rpcError(id, -32022, "Unsupported protocol version", { supported: SUPPORTED });
  }
  const info = { name: "aamio", version: session.packageVersion };
  const modern = (named ?? session.protocolVersion) === MODERN;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const complete = (result, listing = false) =>
    reply(modern ? { resultType: "complete", ...result, ...(listing ? CACHE : {}) } : result);
  switch (method) {
    case "server/discover":
      return reply({
        resultType: "complete", supportedVersions: SUPPORTED, capabilities: CAPABILITIES,
        _meta: { "io.modelcontextprotocol/serverInfo": info }, instructions: INSTRUCTIONS, ...CACHE,
      });
    case "initialize": {
      const protocolVersion = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : "2025-11-25";
      session.protocolVersion = protocolVersion;
      return reply({
        ...(protocolVersion === MODERN ? { resultType: "complete" } : {}),
        protocolVersion, capabilities: CAPABILITIES, serverInfo: info, instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return complete({});
    case "tools/list":
      return complete({ tools: [WHOAMI] }, true);
    case "resources/list":
      return complete({ resources: [] }, true);
    case "resources/templates/list":
      return complete({ resourceTemplates: [] }, true);
    case "prompts/list":
      return complete({ prompts: [] }, true);
    case "tools/call": {
      if (params.name !== WHOAMI.name) return rpcError(id, -32602, "Unknown tool");
      if (params.arguments !== undefined && (!object(params.arguments) || Object.keys(params.arguments).length)) {
        return rpcError(id, -32602, "aamio_whoami takes an empty arguments object");
      }
      try {
        const { key, hash, hash_prefix } = await readIdentity(session.home);
        return complete(toolResult({ key, hash, hash_prefix }, false));
      } catch (failure) {
        const missingHome = failure?.code === "home_not_initialized";
        return complete(toolResult({
          error: missingHome ? "home_not_initialized" : "key_unreadable",
          fix: missingHome ? "Initialize the selected home with aamio init." : "Check the selected home's key file and permissions.",
        }, true));
      }
    }
    default:
      return rpcError(id, -32601, "Method not found");
  }
}

// Bound the buffer even if the sender never ends a line. After an oversized
// line, resume at the following newline so the next request is still usable.
async function* lines(input) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let length = 0;
  let oversized = false;
  for await (const part of input) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const count = end - start;
      if (length + count > buffer.length) oversized = true;
      if (!oversized) {
        chunk.copy(buffer, length, start, end);
        length += count;
      }
      if (newline === -1) break;
      yield oversized ? null : buffer.subarray(0, length);
      length = 0;
      oversized = false;
      start = newline + 1;
    }
  }
  if (oversized || length) yield oversized ? null : buffer.subarray(0, length);
}

export async function serveMcp({ home, version, input = process.stdin, output = process.stdout }) {
  const session = { home, packageVersion: version, protocolVersion: "2025-03-26" };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  async function* responses() {
    for await (const line of lines(input)) {
      if (line === null) {
        yield JSON.stringify(rpcError(null, -32600, "Request line exceeds 64 KiB")) + "\n";
        continue;
      }
      let message;
      try {
        const text = decoder.decode(line).trim();
        if (!text) continue;
        message = JSON.parse(text);
      } catch {
        yield JSON.stringify(rpcError(null, -32700, "Parse error")) + "\n";
        continue;
      }
      if (Array.isArray(message) && message.length > 0) {
        const replies = [];
        for (const item of message) {
          const reply = await handle(item, session);
          if (reply !== undefined) replies.push(reply);
        }
        if (replies.length) yield JSON.stringify(replies) + "\n";
      } else {
        const reply = await handle(message, session);
        if (reply !== undefined) yield JSON.stringify(reply) + "\n";
      }
    }
  }
  await pipeline(responses(), output, { end: false });
}
