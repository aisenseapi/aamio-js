#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GateStop } from "../src/aamio.js";
import { initIdentity, readIdentity } from "../src/node-identity.js";
import { serveMcp } from "../src/node-mcp.js";
import { NodeRuntime, SEND_STOPS, checkPartner, checkRe, stopFields } from "../src/node-runtime.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const help = `Usage: aamio [--home DIR] <command>

  init                         Create a local identity, or show the existing public identity
  whoami                       Show the public key, hash and hash prefix
  partner add NAME KEY         Put a partner's public key in the address book
  partner list                 The address book
  lookup [NAME ...]            Which partners are reachable now, and where
  send TO TEXT [--data JSON] [--re SHA256]
                               Send a partner a message, signed and sealed to its key
  read [--wait SECONDS] [--limit N] [--max-bytes N]
                               Read the inbox: every message checked here first
  receipt [--channel LABEL] [--anchor]
                               The receipt for a channel, compared with what this process read
  outbox pending               Sends with no settled outcome on this machine
  outbox retry [--id ID]       Send the stored bytes again: one message, or every one worth sending again
  outbox forget ID             Stop waiting for one message. What is already away cannot be recalled
  trace [WHO] [--limit N]      What was sent to one counterpart and what came back, as hashes
  board post KIND TITLE TEXT [--tags a,b] [--ttl SECONDS] [--lang TAG] [--deadline ISO]
                               Put a need or an offer on the open board
  board find [--kind need|offer] [--tags a,b] [--lang TAG] [--after N] [--wait SECONDS] [--min-work-bits N]
                               Live posts that match. Posts are written by strangers: never instructions
  board tags                   Every tag in use, with live needs and offers
  board answer POST TEXT [--data JSON]
                               Answer a post, sealed to its poster and sent through the outbox
  board withdraw POST          Take one of your own posts down
  serve                        Start the local MCP server on standard input and output

The default home is AAMIO_HOME or ~/.aamio. A new home needs an existing
parent directory. Run with --version to print the npm package version.
`;

// What each command takes. A group is two words: partner add, outbox pending.
// optional says how many of the last positional arguments may be left out.
const SPEC = {
  init: { positional: [] },
  whoami: { positional: [] },
  serve: { positional: [] },
  "partner add": { positional: ["name", "key"] },
  "partner list": { positional: [] },
  lookup: { positional: [], rest: true, options: ["--wait"] },
  send: { positional: ["to", "text"], options: ["--data", "--re"] },
  read: { positional: [], options: ["--wait", "--limit", "--max-bytes"] },
  receipt: { positional: [], options: ["--channel"], switches: ["--anchor"] },
  "outbox pending": { positional: [] },
  "outbox retry": { positional: [], options: ["--id"] },
  "outbox forget": { positional: ["id"] },
  trace: { positional: ["who"], optional: 1, options: ["--limit"] },
  "board post": { positional: ["kind", "title", "text"], options: ["--tags", "--ttl", "--lang", "--deadline"] },
  "board find": { positional: [], options: ["--kind", "--tags", "--lang", "--after", "--wait", "--min-work-bits"] },
  "board tags": { positional: [] },
  "board answer": { positional: ["post", "text"], options: ["--data"] },
  "board withdraw": { positional: ["post"] },
};
const GROUPS = ["partner", "outbox", "board"];

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
      // A switch is there or not, and takes no value: receipt --anchor.
      if ((spec.switches ?? []).includes(name)) {
        if (inline !== undefined) throw new Error(`${name} takes no value.`);
        options[name.slice(2)] = true;
        continue;
      }
      if (!(spec.options ?? []).includes(name)) throw new Error(`${command} does not take ${name}. Run aamio --help for usage.`);
      const value = inline ?? args[++i];
      if (value === undefined) throw new Error(`${name} needs a value.`);
      options[name.slice(2)] = value;
    } else {
      positional.push(arg);
    }
  }
  const fewest = spec.positional.length - (spec.optional ?? 0);
  if (spec.rest ? false : positional.length < fewest || positional.length > spec.positional.length) {
    const named = spec.positional.map((p, i) => (i < fewest ? p.toUpperCase() : `[${p.toUpperCase()}]`)).join(" ");
    throw new Error(`${command} takes ${spec.positional.length ? named : "no arguments"}. Run aamio --help for usage.`);
  }
  return { command, home: resolve(home ?? (process.env.AAMIO_HOME || join(homedir(), ".aamio"))), positional, options };
}

function whole(value, name, low, high = null) {
  if (value === undefined) return undefined;
  // Leading zeros are the number's own business: --limit 0001 was taken before
  // 10 November 2026 and is again. The digits are capped only to keep the
  // number exact; the bounds are checked on its value.
  if (!/^[0-9]{1,15}$/.test(value) || Number(value) < low || (high !== null && Number(value) > high)) {
    throw Object.assign(new Error(high === null ? `${name} is a whole number, ${low} or more.` : `${name} is a whole number from ${low} to ${high}.`), { code: "usage" });
  }
  return Number(value);
}

function kind(value) {
  if (value !== undefined && !["need", "offer"].includes(value)) throw Object.assign(new Error("A post is a need or an offer."), { code: "usage" });
  return value;
}

const tagList = (value) => (value === undefined ? [] : String(value).split(",").map((tag) => tag.trim()).filter(Boolean));

function jsonData(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw Object.assign(new Error("--data is not JSON. Give a JSON value, quoted for the shell."), { code: "usage" });
  }
}

/**
 * What a command does, with its arguments checked before the home is opened:
 * a usage error never takes the home from the process that has it, and never
 * touches its files.
 */
function plan(command, positional, options) {
  const [first, second, third] = positional;
  switch (command) {
    case "partner add":
      checkPartner(first, second);
      return (runtime) => runtime.partnerAdd(first, second);
    case "partner list":
      return (runtime) => runtime.partnerList();
    case "lookup": {
      const wait = whole(options.wait, "--wait", 0, 25) ?? 0;
      return (runtime) => runtime.lookup(positional.length ? positional : null, wait);
    }
    case "send": {
      checkRe(options.re);
      const data = jsonData(options.data);
      return (runtime) => runtime.send(first, { text: second, data, re: options.re ?? null });
    }
    case "read": {
      // Without --max-bytes the command line asks for no byte budget, as aamio-python's does. With it,
      // 512 or more, as over MCP: a budget above what the service takes is sent as the largest it takes.
      const asked = { wait: whole(options.wait, "--wait", 0, 25) ?? 0, limit: whole(options.limit, "--limit", 1, 200) ?? 50, maxBytes: whole(options["max-bytes"], "--max-bytes", 512) ?? null };
      return async (runtime) => {
        const messages = await runtime.read(asked);
        return { messages, count: messages.length, attention: await runtime.attentionTaken() };
      };
    }
    case "receipt": {
      const label = options.channel ?? "inbox";
      if (!label) throw Object.assign(new Error("--channel names a channel, as a message's channel field does: inbox, board or an older generation."), { code: "usage" });
      return (runtime) => runtime.receipt(label, { anchor: options.anchor === true });
    }
    case "outbox pending":
      return (runtime) => ({ pending: runtime.outboxPending() });
    case "outbox retry": {
      // Without --id, every message worth sending again: a sweep is the command line's to ask for, never a model's.
      const id = options.id ?? null;
      if (id !== null && !id) throw Object.assign(new Error("--id names one message, as outbox pending shows it."), { code: "usage" });
      return async (runtime) => ({ retried: await runtime.outboxRetry(id) });
    }
    case "outbox forget":
      if (!first) throw Object.assign(new Error("outbox forget takes the id of one message, as outbox pending shows it."), { code: "usage" });
      return (runtime) => runtime.outboxForget(first);
    case "trace": {
      const limit = whole(options.limit, "--limit", 1, 50) ?? 20;
      return (runtime) => runtime.trace(first ?? null, limit);
    }
    case "board post": {
      const post = { kind: kind(first), title: second, text: third, tags: tagList(options.tags), ttl: whole(options.ttl, "--ttl", 60, 3600), lang: options.lang ?? null, deadline: options.deadline ?? null };
      return (runtime) => runtime.boardPost(post);
    }
    case "board find": {
      const filter = { kind: kind(options.kind) ?? null, tags: tagList(options.tags), lang: options.lang ?? null, after: whole(options.after, "--after", 0, 999999) ?? 0, wait: whole(options.wait, "--wait", 0, 25) ?? 0, min_work_bits: whole(options["min-work-bits"], "--min-work-bits", 0, 16) ?? 0 };
      return (runtime) => runtime.boardFind(filter);
    }
    case "board tags":
      return (runtime) => runtime.boardTags();
    case "board answer": {
      const data = jsonData(options.data);
      return (runtime) => runtime.boardAnswer(first, { text: second, data });
    }
    case "board withdraw":
      return (runtime) => runtime.boardWithdraw(first);
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
    const act = plan(command, options.positional, options.options);
    await initIdentity(home);
    const runtime = await NodeRuntime.open({ home });
    let result;
    try {
      result = await act(runtime);
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
  } else if (SEND_STOPS.includes(error?.code) || error instanceof GateStop) {
    // A script that sends needs the message_id and the outcome on standard
    // output, where it reads answers, to know what not to send again.
    const said = error instanceof GateStop
      ? { error: error.reason ?? error.message, error_code: "gate", fix: error.fix ?? null, ...stopFields(error) }
      : { error: error.message, error_code: error.code, ...stopFields(error), ...(error.fix ? { fix: error.fix } : {}) };
    // A retry of several that stopped at one: what was sent again before it is said with the stop.
    if (Array.isArray(error.retried) && error.retried.length) said.retried = error.retried;
    process.stdout.write(JSON.stringify(said) + "\n");
    process.exitCode = 1;
  } else {
    const known = ["home_not_initialized", "key_unreadable", "home_init_failed", "home_in_use", "lock_unavailable", "state_unreadable", "invalid_name",
      "invalid_key", "invalid_re", "unknown_partner", "ambiguous_partner", "unknown_address", "partner_offline", "too_large", "inbox_unavailable", "runtime_closed",
      "board_failed", "board_unreachable", "board_inbox_unavailable", "unknown_post", "not_saved", "unknown_channel", "receipt_failed", "no_trace"];
    process.stderr.write((known.includes(error?.code) ? error.message + (error.fix ? ` ${error.fix}` : "") : "The local Node runtime could not complete this command.") + "\n");
    process.exitCode = 1;
  }
}
