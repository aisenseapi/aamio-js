// One party of a carrier exchange over the simulated radio, for the tests across runtimes.
// The same peer as tests/carry_peer.py in aamio-python, with the same JSON file as its one
// argument, the same tasks (exchange, resave and replay) and the same lines out, so any two
// runtimes can be paired. The last line is written before the process ends, since a pipe
// may take it after process.exit otherwise. node --test runs every module under test/ as a
// test file; run that way, without the argument, there is nothing to do.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Keys } from "../src/aamio.js";
import * as carry from "../src/carry.js";
import { CarryRefused } from "../src/carry.js";
import { CarryState, profile } from "../src/node-carry-state.js";
import { Carrier } from "../src/node-carrier.js";
import { TransportProcess, environment } from "../src/node-transport-host.js";

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (text) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const finish = (value, exit = 0) => process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(exit));

if (process.argv[2] !== undefined) await main(JSON.parse(readFileSync(process.argv[2], "utf8")));

async function main(config) {
  const keys = Keys.fromSeedHex(config.seed);
  const partner = fromHex(config.partner);
  const task = config.task ?? "exchange";
  if (task === "resave") {
    // Read a state another runtime wrote and write it back: prune at the time floor deletes nothing.
    new CarryState(keys, config.state).prune(config.now);
    return finish({ resaved: true });
  }
  if (task === "replay") {
    const state = new CarryState(keys, config.state);
    let result, reply;
    try {
      [result, reply] = state.deliver(fromHex(config.envelope), [partner], profile({ mode: config.mode }), 0, config.now);
    } catch (error) {
      if (!(error instanceof CarryRefused)) throw error;
      [result, reply] = [error.code, null];
    }
    return finish({ replayed: result, receipt: reply !== null && reply !== undefined });
  }
  return exchange(config, keys, partner);
}

async function exchange(config, keys, partner) {
  const base = Object.fromEntries(["PATH", "SYSTEMROOT", "TEMP", "TMP"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  const env = { ...environment([], base), PYTHONPATH: config.sim_path, AAMIO_SIM_PORT: String(config.port), AAMIO_SIM_PEERS: String(config.peer) };
  for (const [key, value] of Object.entries(config.medium)) env[key] = String(value);
  const folder = dirname(config.state);
  mkdirSync(folder, { recursive: true });
  const radio = new TransportProcess("sim-radio", "0.1.0", [...config.python, "-u", "-m", "aamio_sim_radio.transport"], folder, env, { describeSeconds: 30 });
  await radio.start("0.0.0-test", "node", folder);
  const carrier = new Carrier(new CarryState(keys, config.state), radio, profile({ mode: config.mode }), [partner], { retrySeconds: 1, askRetrySeconds: 3 });
  const until = Date.now() + config.seconds * 1000;
  const text = new TextEncoder().encode(config.text);
  let stage = "start";
  let sent = null;
  let envelope = null;
  let done = false;
  let exit = 0;
  let last = null;
  try {
    while (!existsSync(config.stop)) {
      if (Date.now() > until) {
        last = { done: false, stage, refused: carrier.refused };
        exit = 1;
        break;
      }
      await carrier.pump(10);
      const opened = carrier.openSession(partner);
      if (config.role === "first") {
        if (stage === "start") {
          carrier.open(partner);
          stage = "opening";
        } else if (stage === "opening" && opened !== null) {
          sent = carrier.send(partner, opened, text);
          envelope = carrier.waiting.get(sent).envelope;
          stage = "sending";
        } else if (stage === "sending" && carrier.confirmed(sent) && carrier.inbox.length) stage = "settling";
      } else if (stage === "start" && carrier.inbox.length) {
        carrier.open(partner);
        stage = "opening";
      } else if (stage === "opening" && opened !== null) {
        sent = carrier.send(partner, opened, text);
        envelope = carrier.waiting.get(sent).envelope;
        stage = "sending";
      } else if (stage === "sending" && carrier.confirmed(sent)) stage = "settling";
      if (stage === "settling" && !done) {
        done = true;
        console.log(JSON.stringify({ done: true }));
      }
    }
    if (exit === 0) {
      const refused = {};
      for (const code of carrier.refused) refused[code] = (refused[code] ?? 0) + 1;
      last = { stopped: true, received: carrier.inbox.map((entry) => new TextDecoder().decode(entry[3])),
        from_partner: carrier.inbox.every((entry) => carry.equal(entry[0], partner)), sent: envelope ? toHex(envelope) : null, refused };
    }
  } finally {
    await radio.stop();
  }
  finish(last, exit);
}
