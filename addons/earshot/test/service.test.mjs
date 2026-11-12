// The two calls to aisenseapi.com, against a stand-in: a function in place of the POST, and a listener on
// 127.0.0.1 that answers as aisense would, or badly. Nothing here leaves this machine. The same checks as the
// service tests of aamio-python's tests/test_earshot_process.py and aamio-php's addons/earshot/tests/process.inc.php.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as codec from "../src/codec.js";
import * as process_ from "../src/process.js";
import * as service from "../src/service.js";

const ADDRESS = "k7rq2m4xw5tbz3yd6ena";
const NOW = 1794150000;
const TIMED = `aamio:scope/${ADDRESS}?n=rom-42&t=${NOW + 3600}`;
const wav = (seconds) => codec.wav(Buffer.alloc(2 * Math.trunc(48000 * seconds)));

const request = (kind, name, args = {}) => ({ aamio_addon: 2, kind, name, arguments: args, subject: null, own_key: null, state_dir: null, deadline_seconds: 90, aamio: { version: "0.6.3", runtime: "node" } });

const caught = async (act) => {
  try {
    await act();
  } catch (error) {
    return error;
  }
  return null;
};

/** A POST that answers what the test chose, and keeps what it was asked. */
function fakePost(status, body, headers = {}) {
  const asked = [];
  const send = async (path, payload, type, limit) => {
    asked.push([path, payload, type, limit]);
    return [status, headers, Buffer.isBuffer(body) ? body : Buffer.from(body)];
  };
  return { asked, send };
}

test("encode posts the card and takes only a WAV", async () => {
  const sound = wav(1);
  const fake = fakePost(200, sound);
  assert.ok((await service.encode("aamio:scope/" + ADDRESS, "audible", fake.send)).equals(sound));
  const [path, payload, type, limit] = fake.asked[0];
  assert.deepEqual([path, type, limit], ["/audio_encode", "application/json", service.MAX_SOUND_BYTES]);
  assert.deepEqual(JSON.parse(payload.toString("utf8")), { data: "aamio:scope/" + ADDRESS, input_encoding: "utf8", mode: "audible" });
  let error = await caught(() => service.encode("x", "audible", fakePost(200, "<html>not a wav</html>").send));
  assert.ok(error instanceof service.Unreachable && error.reason === "service_answered_something_else" && error.answered === true);
  error = await caught(() => service.encode("x", "audible", fakePost(200, Buffer.concat([wav(0.1), Buffer.alloc(service.MAX_SOUND_BYTES)])).send));
  assert.equal(error?.reason, "service_answered_something_else", "a WAV past what aisense makes is not one of its");
});

test("decode posts the WAV to the mode and reads the documented answer", async () => {
  const answer = { data_base64: "SGVsbG8=", byte_length: 5, text: "Hello", protocol: "aisense-audio-v2", corrected_bits: 0, mode: "audible" };
  const fake = fakePost(200, JSON.stringify(answer));
  assert.deepEqual(await service.decode(Buffer.from("RIFF1234WAVE"), "auto", fake.send), answer);
  const [path, payload, type, limit] = fake.asked[0];
  assert.deepEqual([path, payload.toString("latin1"), type, limit], ["/audio_decode/auto", "RIFF1234WAVE", "audio/wav", service.MAX_JSON_BYTES]);
  for (const odd of ["not json", "[1, 2]", JSON.stringify({ text: "no data_base64" }), "null", Buffer.from([0x22, 0xff, 0x22])]) {
    const error = await caught(() => service.decode(Buffer.from("RIFF"), "auto", fakePost(200, odd).send));
    assert.ok(error instanceof service.Unreachable && error.reason === "service_answered_something_else" && error.answered === true, String(odd));
  }
});

test("what aisense answers when it cannot", async () => {
  let error = await caught(() => service.decode(Buffer.from("RIFF"), "auto", fakePost(422, JSON.stringify({ error: "No intact data packet found.", fix: "Start listening before playback." })).send));
  assert.ok(error instanceof service.NothingHeard);
  assert.equal(error.fix, "No complete message was heard: no intact data packet found. Start listening before playback.", "422 is nothing heard, in aisense's words");
  error = await caught(() => service.decode(Buffer.from("RIFF"), "auto", fakePost(422, "").send));
  assert.equal(error.fix, "No complete message was heard. Record the whole sound, close to the speaker, in a quiet room, and try audible mode.");
  error = await caught(() => service.decode(Buffer.from("RIFF"), "auto", fakePost(400, JSON.stringify({ error: "Use PCM16 WAV.", fix: "Check the format." })).send));
  assert.ok(error instanceof service.Refused && error.reason === "not_readable");
  assert.equal(error.fix, "aisenseapi.com would not take it: Use PCM16 WAV. Check the format.", "400 is a file aisense does not read");
  error = await caught(() => service.encode("x", "audible", fakePost(413, "too long").send));
  assert.ok(error instanceof service.Refused && error.reason === "service_refused");
  assert.equal(error.fix, "aisenseapi.com would not take it: HTTP 413.");
  error = await caught(() => service.encode("x", "audible", fakePost(429, "{}", { "retry-after": "3600" }).send));
  assert.ok(error instanceof service.Unreachable && error.reason === "rate_limited" && error.retryAfter === "3600" && error.answered === true);
  assert.equal(error.fix, "aisenseapi.com counts requests per address and day, and this address has used its share for now. Try again after 3600 seconds.");
  error = await caught(() => service.decode(Buffer.from("RIFF"), "auto", fakePost(503, "{}", { "retry-after": "20" }).send));
  assert.ok(error instanceof service.Unreachable && error.reason === "service_busy" && error.retryAfter === "20");
  error = await caught(() => service.encode("x", "audible", fakePost(502, "bad gateway").send));
  assert.ok(error instanceof service.Unreachable && error.reason === "service_unreachable" && error.answered === true);
  assert.equal(error.fix, "aisenseapi.com answered HTTP 502, so nothing was played. Try again later.");
  error = await caught(() => service.decode(Buffer.from("RIFF"), "auto", fakePost(500, "").send));
  assert.equal(error.fix, "aisenseapi.com answered HTTP 500, so nothing was read. Try again later.");
});

// A listener on 127.0.0.1 that keeps the whole body of every request, and answers each with what the test chose.
async function receiver(t, answer) {
  const bodies = [];
  const seen = [];
  const sockets = new Set();
  const server = createServer((incoming, response) => {
    const parts = [];
    incoming.on("data", (part) => parts.push(part));
    incoming.on("end", () => {
      bodies.push(Buffer.concat(parts));
      seen.push({ method: incoming.method, url: incoming.url, headers: incoming.headers });
      answer(incoming, response);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, bodies, seen, send: (options = {}) => (path, body, type, limit) => service.post(path, body, type, limit, { base, ...options }) };
}

const busy = (incoming, response) => {
  response.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
  response.end('{"error": "Busy."}');
};

test("one POST: the whole request, the answer capped, and no redirect followed", async (t) => {
  const sound = wav(0.5);
  const fine = await receiver(t, (incoming, response) => {
    response.writeHead(200, { "Content-Type": "audio/wav" });
    response.end(sound);
  });
  assert.ok((await service.encode(TIMED, "high", fine.send())).equals(sound));
  assert.deepEqual([fine.seen[0].method, fine.seen[0].url, fine.seen[0].headers["content-type"], fine.seen[0].headers["user-agent"]], ["POST", "/audio_encode", "application/json", "aamio-earshot/" + process_.VERSION]);
  assert.equal(Number(fine.seen[0].headers["content-length"]), fine.bodies[0].length);
  assert.deepEqual(JSON.parse(fine.bodies[0].toString("utf8")), { data: TIMED, input_encoding: "utf8", mode: "high" });
  // Past the limit, one byte more than it is kept, so the caller sees it was more.
  const [status, , payload] = await service.post("/audio_encode", Buffer.from("{}"), "application/json", 1000, { base: fine.base });
  assert.deepEqual([status, payload.length], [200, 1001]);

  const elsewhere = await receiver(t, (incoming, response) => response.end("should never be asked"));
  const moved = await receiver(t, (incoming, response) => {
    response.writeHead(302, { Location: elsewhere.base + "/audio_encode" });
    response.end();
  });
  const error = await caught(() => service.encode(TIMED, "audible", moved.send()));
  assert.ok(error instanceof service.Unreachable && error.reason === "service_unreachable" && error.answered === true);
  assert.equal(error.fix, "aisenseapi.com answered HTTP 302, so nothing was played. Try again later.");
  assert.equal(elsewhere.seen.length, 0, "the card went nowhere a redirect named");

  // In the clear only to this machine, in a test: any other address is refused before a connection is made.
  await assert.rejects(() => service.post("/audio_encode", Buffer.from("{}"), "application/json", 10, { base: "http://example.invalid" }), /over HTTPS, or to 127\.0\.0\.1 in a test/);
  await assert.rejects(() => service.post("/audio_encode", Buffer.from("{}"), "application/json", 10, { base: "ftp://127.0.0.1" }), /over HTTPS/);
  assert.equal(service.BASE, "https://aisenseapi.com/services/v1");
});

test("a network that fails is unreachable, and says whether the request had been taken", async (t) => {
  // Nothing listens: the address of a listener that was closed again.
  const closed = createSocketServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  let error = await caught(() => service.encode("x", "audible", (path, body, type, limit) => service.post(path, body, type, limit, { base: `http://127.0.0.1:${port}` })));
  assert.ok(error instanceof service.Unreachable && error.reason === "service_unreachable" && error.answered === false);
  assert.match(error.fix, /^aisenseapi\.com, which makes and reads the sound, could not be reached: ECONNREFUSED\. Check the network and try again\.$/);

  // It takes the request and never answers.
  const silent = await receiver(t, () => {});
  error = await caught(() => service.encode("x", "audible", silent.send({ timeout: 0.3 })));
  assert.ok(error instanceof service.Unreachable && error.answered === false);
  assert.match(error.fix, /could not be reached: ETIMEDOUT\./);

  // The answer begins, and breaks off: cut, or stalled past the time allowed.
  const cut = await receiver(t, (incoming, response) => {
    response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": "100000" });
    response.write(Buffer.from("RIFF"));
    setTimeout(() => incoming.socket.destroy(), 20);
  });
  error = await caught(() => service.encode("x", "audible", cut.send()));
  assert.ok(error instanceof service.Unreachable && error.reason === "service_unreachable" && error.answered === true);
  assert.match(error.fix, /^aisenseapi\.com answered, and the answer broke off: .*\. Try again\.$/);
  const stall = await receiver(t, (incoming, response) => {
    response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": "100000" });
    response.write(Buffer.from("RIFF"));
  });
  error = await caught(() => service.decode(wav(0.1), "auto", stall.send({ timeout: 0.3 })));
  assert.ok(error instanceof service.Unreachable && error.answered === true);
  assert.match(error.fix, /the answer broke off: ETIMEDOUT\./);
});

test("a sound made here after aisense answered says the card had gone there, and so with a recording", async (t) => {
  const place = await mkdtemp(join(tmpdir(), "aamio-earshot-test-"));
  t.after(() => rm(place, { recursive: true, force: true }));
  const aisense = await receiver(t, busy);
  const recording = codec.encode(Buffer.from(TIMED), "audible");
  const heard = join(place, "heard.wav");
  await writeFile(heard, recording);
  const seams = {
    encode: (text, mode) => service.encode(text, mode, aisense.send()),
    decode: (sound, mode) => service.decode(sound, mode, aisense.send()),
    clock: () => NOW,
  };
  let said = await process_.handle(request("command", "broadcast", { address: ADDRESS, name: "rom-42", out: join(place, "card.wav") }), seams);
  let result = said.result;
  assert.equal(JSON.parse(aisense.bodies[0].toString("utf8")).data, result.card, "the card had reached it whole when it answered 503");
  assert.deepEqual([said.exit_code, result.status, result.engine, result.fallback], [0, "written", "local", { from: "aisense", reason: "service_busy", sent: "yes" }]);
  assert.ok(result.engine_note.includes("The card had gone to aisenseapi.com with the request.") && !result.engine_note.includes("nothing went"));
  assert.ok(existsSync(join(place, "card.wav")));
  said = await process_.handle(request("command", "decode", { file: heard }), seams);
  result = said.result;
  assert.ok(aisense.bodies[1].equals(recording), "the recording had reached it whole");
  assert.deepEqual([result.status, result.engine, result.fallback.sent, result.card.name], ["heard", "local", "yes", "rom-42"]);
  assert.ok(result.engine_note.includes("The recording had gone to aisenseapi.com with the request."));
});

test("an answer that breaks off is done here too", async (t) => {
  const place = await mkdtemp(join(tmpdir(), "aamio-earshot-test-"));
  t.after(() => rm(place, { recursive: true, force: true }));
  const heard = join(place, "heard.wav");
  await writeFile(heard, codec.encode(Buffer.from(TIMED), "audible"));
  const answers = {
    cut: (incoming, response) => {
      response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": "100000" });
      response.write(Buffer.from("RIFF"));
      setTimeout(() => incoming.socket.destroy(), 20);
    },
    stall: (incoming, response) => {
      response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": "100000" });
      response.write(Buffer.from("RIFF"));
    },
  };
  for (const [name, answer] of Object.entries(answers)) {
    const aisense = await receiver(t, answer);
    const seams = {
      encode: (text, mode) => service.encode(text, mode, aisense.send({ timeout: 0.5 })),
      decode: (sound, mode) => service.decode(sound, mode, aisense.send({ timeout: 0.5 })),
      clock: () => NOW,
    };
    let said = await process_.handle(request("command", "broadcast", { address: ADDRESS, out: join(place, `${name}.wav`) }), seams);
    assert.deepEqual([said.exit_code, said.result.engine, said.result.fallback.sent], [0, "local", "yes"], `${name}: the sound is made here all the same`);
    said = await process_.handle(request("command", "decode", { file: heard }), seams);
    assert.deepEqual([said.result.status, said.result.engine, said.result.fallback.sent], ["heard", "local", "yes"], name);
  }
});
