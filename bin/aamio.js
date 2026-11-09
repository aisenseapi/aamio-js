#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GateStop } from "../src/aamio.js";
import { initIdentity, readIdentity } from "../src/node-identity.js";
import { serveMcp } from "../src/node-mcp.js";
import { NodeRuntime } from "../src/node-runtime.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const help = `Usage: aamio [--home DIR] <command>

  init                         Create a local identity, or show the existing public identity
  whoami                       Show the public key, hash and hash prefix
  partner add NAME KEY         Put a partner's public key in the address book
  partner list                 The address book
  lookup [NAME ...]            Which partners are reachable now, and where
  send TO TEXT [--data JSON] [--re SHA256]
                               Send a partner a message, signed and sealed to its key
  read [--wait SECONDS] [--limit N]
                               Read the inbox: every message checked here first
  outbox pending               Sends with no settled outcome on this machine
  serve                        Start the local MCP server on standard input and output

The default home is AAMIO_HOME or ~/.aamio. A new home needs an existing
parent directory. Run with --version to print the npm package version.
`;

// What each command takes. A group is two words: partner add, outbox pending.
const SPEC = {
  init: { positional: [] },
  whoami: { positional: [] },
  serve: { positional: [] },
  "partner add": { positional: ["name", "key"] },
  "partner list": { positional: [] },
  lookup: { positional: [], rest: true, options: ["--wait"] },
  send: { positional: ["to", "text"], options: ["--data", "--re"] },
  read: { positional: [], options: ["--wait", "--limit"] },
  "outbox pending": { positional: [] },
};
const GROUPS = ["partner", "outbox"];

function parse(argv) {
  let home;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--home" || arg.startsWith("--home=")) {
      const value = arg === "--home" ? argv[++i] : arg.slice("--home=".length);
      if (home !== undefined || !value || (arg === "--home" && value.startsWith("-"))) {
        throw new Error("Supply --home once with a directory path.");
      }
      home = value;
    } else {
      args.push(arg);
    }
  }
  if (args.length === 0 || (args.length === 1 && ["-h", "--help", "help"].includes(args[0]))) {
    return { command: "help" };
  }
  if (args.length === 1 && args[0] === "--version") return { command: "version" };
  const command = GROUPS.includes(args[0]) ? `${args[0]} ${args[1] ?? ""}`.trim() : args[0];
  const spec = SPEC[command];
  if (!spec) throw new Error(`Expected one of: ${Object.keys(SPEC).join(", ")}. Run aamio --help for usage.`);
  const positional = [];
  const options = {};
  let ended = false;
  for (let i = command.split(" ").length; i < args.length; i++) {
    const arg = args[i];
    if (!ended && arg === "--") {
      ended = true;
    } else if (!ended && arg.startsWith("--")) {
      const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
      if (!(spec.options ?? []).includes(name)) throw new Error(`${command} does not take ${name}. Run aamio --help for usage.`);
      const value = inline ?? args[++i];
      if (value === undefined) throw new Error(`${name} needs a value.`);
      options[name.slice(2)] = value;
    } else {
      positional.push(arg);
    }
  }
  if (spec.rest ? false : positional.length !== spec.positional.length) {
    throw new Error(`${command} takes ${spec.positional.length ? spec.positional.map((p) => p.toUpperCase()).join(" ") : "no arguments"}. Run aamio --help for usage.`);
  }
  return { command, home: resolve(home ?? (process.env.AAMIO_HOME || join(homedir(), ".aamio"))), positional, options };
}

function whole(value, name, low, high) {
  if (value === undefined) return undefined;
  if (!/^[0-9]{1,6}$/.test(value) || Number(value) < low || Number(value) > high) throw Object.assign(new Error(`${name} is a whole number from ${low} to ${high}.`), { code: "usage" });
  return Number(value);
}

async function run(runtime, command, positional, options) {
  const [first, second] = positional;
  switch (command) {
    case "partner add":
      return runtime.partnerAdd(first, second);
    case "partner list":
      return runtime.partnerList();
    case "lookup":
      return runtime.lookup(positional.length ? positional : null, whole(options.wait, "--wait", 0, 25) ?? 0);
    case "send": {
      let data = null;
      if (options.data !== undefined) {
        try {
          data = JSON.parse(options.data);
        } catch {
          throw Object.assign(new Error("--data is not JSON. Give a JSON value, quoted for the shell."), { code: "usage" });
        }
      }
      return runtime.send(first, { text: second, data, re: options.re ?? null });
    }
    case "read": {
      const messages = await runtime.read({ wait: whole(options.wait, "--wait", 0, 25) ?? 0, limit: whole(options.limit, "--limit", 1, 200) ?? 50 });
      return { messages, count: messages.length, attention: await runtime.attentionTaken() };
    }
    case "outbox pending":
      return { pending: runtime.outboxPending() };
    default:
      throw new Error("unknown command " + command);
  }
}

async function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(error.message + "\n");
    return 2;
  }
  const { command, home } = options;
  if (command === "help") process.stdout.write(help);
  else if (command === "version") process.stdout.write(version + "\n");
  else if (command === "serve") {
    await initIdentity(home);
    // One live runtime per home, Node, Python or PHP: serve holds the home,
    // owner.lock and all, for as long as it runs, as the other servers do.
    const runtime = await NodeRuntime.open({ home });
    // Presence lives two minutes. Once a read or a send has opened the inbox,
    // it is published again every minute and the inbox renewed before it runs
    // out, so partners keep finding this server. Nothing goes out before that.
    const keepalive = setInterval(() => {
      runtime.serial(async () => {
        if (runtime.closed || !runtime.channel("inbox")) return;
        await runtime.ensureInbox();
        await runtime.publishPresence();
      }).catch(() => {});
    }, 30_000);
    keepalive.unref();
    try {
      await serveMcp({ home, version, runtime });
    } finally {
      clearInterval(keepalive);
      await runtime.serial(() => runtime.close());
    }
  } else if (command === "init" || command === "whoami") {
    const identity = command === "init" ? await initIdentity(home) : await readIdentity(home);
    process.stdout.write(JSON.stringify(identity) + "\n");
  } else {
    await initIdentity(home);
    const runtime = await NodeRuntime.open({ home });
    let result;
    try {
      result = await run(runtime, command, options.positional, options.options);
    } finally {
      await runtime.close();
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error?.code === "usage") {
    process.stderr.write(error.message + "\n");
    process.exitCode = 2;
  } else if (error?.code === "send_failed" || error?.code === "not_sent" || error instanceof GateStop) {
    // A script that sends needs the message_id and the outcome on standard
    // output, where it reads answers, to know what not to send again.
    const said = error instanceof GateStop
      ? { error: error.reason ?? error.message, error_code: "gate", fix: error.fix ?? null }
      : { error: error.message, error_code: error.code, outcome: error.outcome, message_id: error.message_id, ...(error.status !== undefined ? { status: error.status } : {}), ...(error.outbox_error ? { outbox_error: error.outbox_error } : {}) };
    process.stdout.write(JSON.stringify(said) + "\n");
    process.exitCode = 1;
  } else {
    const known = ["home_not_initialized", "key_unreadable", "home_init_failed", "home_in_use", "lock_unavailable", "state_unreadable", "invalid_name",
      "invalid_key", "invalid_re", "unknown_partner", "ambiguous_partner", "unknown_address", "partner_offline", "too_large", "inbox_unavailable", "runtime_closed"];
    process.stderr.write((known.includes(error?.code) ? error.message : "The local Node runtime could not complete this command.") + "\n");
    process.exitCode = 1;
  }
}
