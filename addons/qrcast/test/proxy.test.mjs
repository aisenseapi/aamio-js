// What the README says of a proxy, tried on the Node that runs this: the aisense engine connects directly unless
// Node is told to use the proxy the environment names, and knows how. Two listeners on 127.0.0.1 and nothing else:
// one stands in for aisenseapi.com, the other is a proxy that only counts what it is asked for. The add-on's own
// post() runs in a process of its own, as it does under aamio, with the variables aamio passes on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const SERVICE = new URL("../src/service.js", import.meta.url).href;
const CODE = `const service = await import(process.argv[1]);
try {
  await service.post("/probe", Buffer.from("x"), "application/octet-stream", 4096, { base: process.argv[2] });
  console.log("answered");
} catch (error) {
  console.log(error?.reason ?? "failed");
}`;

function listener(t, status) {
  const asked = [];
  const server = createServer((incoming, response) => {
    incoming.resume();
    incoming.on("end", () => {
      asked.push(`${incoming.method} ${incoming.url}`);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  // A proxy is asked for a tunnel. It gives none: that it was asked is what is counted.
  server.on("connect", (incoming, socket) => {
    asked.push(`CONNECT ${incoming.url}`);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ asked, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function run(base, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CODE, SERVICE, base], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", () => resolve(out.trim() || err.trim()));
  });
}

test("the aisense engine connects directly unless Node is told to use a proxy and knows how", async (t) => {
  const service = await listener(t, 200);
  const proxy = await listener(t, 502);
  const named = { HTTP_PROXY: proxy.url, http_proxy: proxy.url, HTTPS_PROXY: proxy.url, https_proxy: proxy.url };

  // A proxy in the environment is not used by itself.
  assert.equal(await run(service.url, named), "answered");
  assert.deepEqual([service.asked, proxy.asked], [["POST /probe"], []]);

  // With the setting it depends on the Node, and the request goes one way only.
  service.asked.length = 0;
  const said = await run(service.url, { ...named, NODE_USE_ENV_PROXY: "1" });
  assert.equal(service.asked.length + proxy.asked.length, 1, said);
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 24) {
    assert.deepEqual([service.asked, proxy.asked.length, said], [[], 1, "service_unreachable"], "Node 24 asks the proxy, and one that gives no way through is the service not reached");
  } else if (major === 20) {
    assert.deepEqual([service.asked, proxy.asked, said], [["POST /probe"], [], "answered"], "Node 20 does not know the setting");
  }
});
