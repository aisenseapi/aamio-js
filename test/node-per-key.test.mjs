// per_key without allow, answered here with a name from the address book. The service's advice for such a gate is
// allow ["*"], a list of keys. Here allow takes partner names, and "*" was answered unknown_partner (a review of 13
// November 2026). The service is not asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keys } from "../src/aamio.js";
import { initIdentity } from "../src/node-identity.js";
import { NodeRuntime } from "../src/node-runtime.js";
import { BOARD, FakeAamio } from "./fake-aamio.mjs";

test("per_key without allow is answered here with a name from the address book, and the service is not asked", async (t) => {
  const fake = new FakeAamio();
  const root = await mkdtemp(join(tmpdir(), "aamio-node-perkey-"));
  const home = join(root, "home");
  await initIdentity(home);
  const runtime = await NodeRuntime.open({ home, host: "https://fake.aamio", board: BOARD, fetch: (url, init) => fake.fetch(url, init), clock: () => fake.time });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  runtime.client.open = async () => assert.fail("the service was asked");
  const gate = { require: { per_key: 5 } };
  await assert.rejects(runtime.channelOpen("deal", { gate }), (error) => error.code === "invalid_gate" && error.message.includes("aamio partner add NAME KEY") && !error.message.includes("*"));
  await runtime.partnerAdd("bob", Keys.generate().public);
  await assert.rejects(runtime.channelOpen("deal", { gate }), (error) => error.message.includes('allow: ["bob"] over MCP, or --allow=bob on the command line'));
  await assert.rejects(runtime.channelOpen("deal", { allow: ["*"], gate }), (error) => error.code === "unknown_partner");
});


test("the per_key advice keeps a name whole", async () => {
  // A name with a space or a quote was put into the advice unquoted, and was not one argument or not JSON (a review of
  // 14 November 2026).
  const { perKeyFix } = await import("../src/node-runtime.js");
  for (const name of ["Anne Hansen", 'Anne "A"', "back\\slash", "a,b", "bob"]) {
    const said = perKeyFix([name]);
    assert.deepEqual(JSON.parse(said.split("allow: ")[1].split(" over MCP")[0]), [name], said);
    if (name === "bob") assert.ok(said.includes("--allow=bob on the command line"));
    else assert.ok(!said.includes(`--allow ${name}`), said);
  }
});


test("the command line in the per_key advice is one the parser takes", async (t) => {
  // A name that starts with a hyphen was read as an option: --allow --home answered "Supply --home once" (a review of
  // 14 November 2026). As --allow=NAME the parser takes it whole, and the partner is looked up.
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { perKeyFix } = await import("../src/node-runtime.js");
  const bin = fileURLToPath(new URL("../bin/aamio.js", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "aamio-node-perkey-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  assert.equal(spawnSync(process.execPath, [bin, "--home", home, "init"], { encoding: "utf8" }).status, 0);
  for (const name of ["-anne", "--bob", "--home", "bob"]) {
    assert.ok(perKeyFix([name]).includes(`--allow=${name} on the command line`), name);
    const ran = spawnSync(process.execPath, [bin, "--home", home, "--host", "http://127.0.0.1:9", "channel", "open", "deal", `--allow=${name}`, "--gate", '{"require": {"per_key": 5}}'], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(ran.stdout), { error: `unknown partner: ${name}`, error_code: "unknown_partner" }, ran.stdout + ran.stderr);
  }
});
