// The fake aamio over HTTP on the loopback, for the commands that run as a process of their own: one listener for the
// service and one for the board, each handing what it gets to the fake's fetch under the name the fake knows it by.
// A failure the fake answers with no answer at all is a connection dropped here. Nothing in this file listens until a
// test asks it to, and nothing goes anywhere but 127.0.0.1.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { BOARD } from "./fake-aamio.mjs";

const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));

function listen(fake, origin) {
  const server = createServer(async (request, response) => {
    try {
      const parts = [];
      for await (const part of request) parts.push(part);
      const method = request.method;
      const init = { method, headers: { ...request.headers } };
      if (method !== "GET" && method !== "HEAD") init.body = Buffer.concat(parts).toString("utf8");
      const answer = await fake.fetch(origin + request.url, init);
      const text = await answer.text();
      response.writeHead(answer.status, { "Content-Type": answer.headers.get("content-type") || "application/json" });
      response.end(text);
    } catch {
      request.socket.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const closed = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(() => resolve());
});

/**
 * Serves the fake for as long as the test runs. cli(home, ...args) runs one command of the command line against it
 * and gives its exit status and what it wrote. The command's clock is the machine's, so a fake that commands read
 * from is made with the machine's time: new FakeAamio({ now: Math.floor(Date.now() / 1000) }).
 */
export async function serveFake(t, fake, { host = "https://fake.aamio" } = {}) {
  const service = await listen(fake, host);
  const board = await listen(fake, BOARD);
  t.after(async () => {
    await closed(service);
    await closed(board);
  });
  const env = { ...process.env, AAMIO_HOST: `http://127.0.0.1:${service.address().port}`, AAMIO_BOARD: `http://127.0.0.1:${board.address().port}`, AAMIO_VERIFYUM: "http://127.0.0.1:9" };
  const cli = (home, ...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "--home", home, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
  return { env, cli };
}
