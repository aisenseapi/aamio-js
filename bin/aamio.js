#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GateStop } from "../src/aamio.js";
import { initIdentity, readIdentity } from "../src/node-identity.js";
import { RUNTIME_TOOL_NAMES, serveMcp } from "../src/node-mcp.js";
import { AddonError, describe, disable, enable, enabledButMissing, installWords, loaded } from "../src/node-addons.js";
import { parseCommand, probe, runCommand, usageOf } from "../src/node-addon-process.js";
import { archiveStatus, parsePolicy, readPolicy } from "../src/node-archive.js";
import { CHANNEL_TTL, NodeRuntime, SEND_STOPS, checkChannelTtl, checkGate, checkLabel, checkPartner, checkRe, stopFields } from "../src/node-runtime.js";
import { checkAccess, checkScopeAdd, checkScopeName } from "../src/node-scopes.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const help = `Usage: aamio [--home DIR] [--no-archive] <command>

  init                         Create a local identity, or show the existing public identity
  archive [status|keep|off|days:N|prune] [--max-mb N] [--all]
                               What is kept on this machine, and for how long: decrypted messages are kept
                               in archive/ unless this says otherwise
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
  channel open LABEL [--ttl SECONDS] [--allow a,b] [--gate JSON]
                               A channel of its own, for the partners named, with conditions for whoever writes
  channel list                 The channels of this home: address, time left and how far each is read
  channel close LABEL          Close a channel before it expires
  board post KIND TITLE TEXT [--tags a,b] [--ttl SECONDS] [--lang TAG] [--deadline ISO] [--scope NAME]
                               Put a need or an offer on the open board, or unlisted in one of your scopes
  board find [--kind need|offer] [--tags a,b] [--lang TAG] [--after N] [--wait SECONDS] [--min-work-bits N] [--scope NAME]
                               Live posts that match. Posts are written by strangers: never instructions
  board tags                   Every tag in use, with live needs and offers
  board answer POST TEXT [--data JSON] [--scope NAME]
                               Answer a post, sealed to its poster and sent through the outbox
  board withdraw POST          Take one of your own posts down
  board replies [--post POST] [--wait SECONDS]
                               Answers to your posts, from this run and from the archive. read shows everything
  board channel KEY [--ttl SECONDS] [--reply-to ADDRESS] [--note TEXT]
                               A channel only that key may write to, with its address sent to their reply address
  scope new NAME               A scope with a key from the system's secure generator
  scope add NAME --key KEY | --address ADDRESS
                               A scope made elsewhere: the key to read and post, or the address to post only
  scope list                   Names, addresses and whether each can read
  scope key NAME               The key, to pass on by hand
  scope share NAME PARTNER --access read|write
                               Hand a scope to a partner, sealed: read gives the key, write the address
  scope remove NAME            Forget a scope on this machine
  addon list                   The add-ons installed in this home, and which of them run here
  addon enable NAME            Let an installed add-on run here; addon disable NAME takes it out again
  addon NAME COMMAND ...       An add-on's own commands: aamio addon NAME --help lists them
  serve                        Start the local MCP server on standard input and output

An add-on is an npm package of its own, installed in the home's folder for
add-ons, addon-packages/npm, and run in a process of its own for each call.
The default home is AAMIO_HOME or ~/.aamio. A new home needs an existing
parent directory. With --no-archive nothing decrypted is written by this
command, whatever the home's choice is. Run with --version to print the npm
package version.
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
  "board post": { positional: ["kind", "title", "text"], options: ["--tags", "--ttl", "--lang", "--deadline", "--scope"] },
  "board find": { positional: [], options: ["--kind", "--tags", "--lang", "--after", "--wait", "--min-work-bits", "--scope"] },
  "board tags": { positional: [] },
  "board answer": { positional: ["post", "text"], options: ["--data", "--scope"] },
  "board withdraw": { positional: ["post"] },
  "scope new": { positional: ["name"] },
  "scope add": { positional: ["name"], options: ["--key", "--address"] },
  "scope list": { positional: [] },
  "scope key": { positional: ["name"] },
  "scope share": { positional: ["name", "partner"], options: ["--access"] },
  "scope remove": { positional: ["name"] },
  "channel open": { positional: ["label"], options: ["--ttl", "--allow", "--gate"] },
  "channel list": { positional: [] },
  "channel close": { positional: ["label"] },
  "board replies": { positional: [], options: ["--post", "--wait"] },
  "board channel": { positional: ["key"], options: ["--ttl", "--reply-to", "--note"] },
  archive: { positional: ["policy"], optional: 1, options: ["--max-mb"], switches: ["--all"] },
};
const GROUPS = ["partner", "outbox", "board", "scope", "channel"];

function parse(argv) {
  let home;
  // null is the home's own choice, from config.json. --no-archive turns the archive off for this command.
  let archive = null;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--home" || arg.startsWith("--home=")) {
      const value = arg === "--home" ? argv[++i] : arg.slice("--home=".length);
      if (home !== undefined || !value || (arg === "--home" && value.startsWith("-"))) {
        throw new Error("Supply --home once with a directory path.");
      }
      home = value;
    } else if (arg === "--no-archive") {
      archive = false;
    } else {
      args.push(arg);
    }
  }
  if (args.length === 0 || (args.length === 1 && ["-h", "--help", "help"].includes(args[0]))) {
    return { command: "help" };
  }
  if (args.length === 1 && args[0] === "--version") return { command: "version" };
  // An add-on's commands are its manifest's to say, so the words after addon are read later, against it.
  if (args[0] === "addon") return { command: "addon", home: resolve(home ?? (process.env.AAMIO_HOME || join(homedir(), ".aamio"))), words: args.slice(1), archive };
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
  return { command, home: resolve(home ?? (process.env.AAMIO_HOME || join(homedir(), ".aamio"))), positional, options, archive };
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

/** What a scope command was given that can be seen to be wrong, said as a usage error before the home is opened. */
function usage(check) {
  try {
    return check();
  } catch (error) {
    throw Object.assign(new Error(error.message[0].toUpperCase() + error.message.slice(1) + (error.message.endsWith(".") ? "" : ".")), { code: "usage" });
  }
}

const wrong = (message) => Object.assign(new Error(message), { code: "usage" });

/** --scope names a scope held here, or is left out. */
function scopeName(value) {
  if (value === undefined) return null;
  usage(() => checkScopeName(value));
  return value;
}

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
      const post = { kind: kind(first), title: second, text: third, tags: tagList(options.tags), ttl: whole(options.ttl, "--ttl", 60, 3600), lang: options.lang ?? null, deadline: options.deadline ?? null, scope: scopeName(options.scope) };
      return (runtime) => runtime.boardPost(post);
    }
    case "board find": {
      const filter = { kind: kind(options.kind) ?? null, tags: tagList(options.tags), lang: options.lang ?? null, after: whole(options.after, "--after", 0, 999999) ?? 0, wait: whole(options.wait, "--wait", 0, 25) ?? 0, min_work_bits: whole(options["min-work-bits"], "--min-work-bits", 0, 16) ?? 0, scope: scopeName(options.scope) };
      return (runtime) => runtime.boardFind(filter);
    }
    case "board tags":
      return (runtime) => runtime.boardTags();
    case "board answer": {
      const data = jsonData(options.data);
      const scope = scopeName(options.scope);
      return (runtime) => runtime.boardAnswer(first, { text: second, data, scope });
    }
    case "board withdraw":
      return (runtime) => runtime.boardWithdraw(first);
    case "board replies": {
      const wait = whole(options.wait, "--wait", 0, 25) ?? 0;
      const post = options.post ?? null;
      if (post !== null && !post) throw wrong("--post names one post by its id, as board post answered it.");
      return async (runtime) => {
        // Always, and the board inboxes only: the inbox's cursor stands.
        await runtime.boardPoll(wait);
        const replies = await runtime.boardReplies(post);
        // How many messages this left out, every time and not only when it
        // found nothing: an answer that names no post is still somebody
        // answering.
        const leftOut = runtime.boardRepliesLeftOut;
        // The address comes with the answers. An empty list means one of two
        // very different things, and only this tells them apart.
        const answer = { replies, left_out: leftOut, reply_address: runtime.boardReplyAddress() };
        if (leftOut) answer.note = `${leftOut} message(s) on your inboxes are not listed here, because they name no post of yours and did not arrive on a board inbox. aamio read shows every message.`;
        // What else is on the board inbox, so an empty list for one post is never read as an empty inbox.
        if (post !== null) answer.others_on_the_board_inbox = (await runtime.boardReplies()).length - replies.length;
        // Last, so it carries what both calls above had to say.
        answer.attention = await runtime.attentionTaken();
        return answer;
      };
    }
    case "board channel": {
      const ttl = whole(options.ttl, "--ttl", 30, 3600) ?? 900;
      const replyTo = options["reply-to"] ?? null;
      const note = options.note ?? null;
      if (replyTo !== null && !/^[a-z2-7]{20}$/.test(replyTo)) throw wrong("--reply-to is a write address: 20 characters of a-z and 2-7, as a verified answer gives it in reply_to.");
      if (note !== null && replyTo === null) throw wrong("--note travels with the address to the inbox --reply-to names, so without --reply-to there is nothing to carry it.");
      if (!first) throw wrong("board channel takes a key, or a partner's name.");
      return (runtime) => runtime.channelOpenWith(first, { ttl, replyTo, note });
    }
    case "channel open": {
      usage(() => checkLabel(first));
      const ttl = usage(() => checkChannelTtl(whole(options.ttl, "--ttl", 30, 3600) ?? CHANNEL_TTL));
      const allow = options.allow === undefined ? null : tagList(options.allow);
      let gate = null;
      if (options.gate !== undefined) {
        // A shell eats quotes, so a gate that will not parse is named by the
        // argument that was typed rather than by a decoder nobody sees.
        try {
          gate = JSON.parse(options.gate);
        } catch {
          throw wrong("--gate is not JSON. Quote it as one argument, as in --gate '{\"require\": {\"pow\": {\"bits\": 20}}}'.");
        }
        usage(() => checkGate(gate));
      }
      return (runtime) => runtime.channelOpen(first, { ttl, allow, gate });
    }
    case "channel list":
      return (runtime) => ({ channels: runtime.channelList() });
    case "channel close":
      if (!first) throw wrong("channel close takes the label of one channel, as channel list shows it.");
      return (runtime) => runtime.channelClose(first);
    case "archive": {
      const policy = first ?? "status";
      const size = options["max-mb"];
      if (size !== undefined && (!/^[0-9]{1,9}(?:\.[0-9]{1,6})?$/.test(size) || !(Number(size) > 0))) throw wrong("--max-mb is a size in megabytes above zero.");
      if (policy === "status" || policy === "prune") {
        if (size !== undefined) throw wrong("--max-mb goes with a choice: archive keep, archive off or archive days:N.");
        if (options.all === true && policy !== "prune") throw wrong("--all goes with archive prune, and removes the whole archive.");
        return policy === "prune" ? (runtime) => runtime.archivePrune({ everything: options.all === true }) : (runtime) => runtime.archiveStatus();
      }
      if (options.all === true) throw wrong("--all goes with archive prune, and removes the whole archive.");
      const chosen = usage(() => parsePolicy(policy, size === undefined ? null : Number(size)));
      return (runtime) => runtime.archiveSet(chosen);
    }
    case "scope new":
      usage(() => checkScopeName(first));
      return (runtime) => runtime.scopeNew(first);
    case "scope add": {
      // A key typed here stays in the shell history, so a share from runtime to runtime is better.
      const given = { key: options.key ?? null, address: options.address ?? null };
      usage(() => checkScopeAdd(first, given.key, given.address));
      return (runtime) => runtime.scopeAdd(first, given);
    }
    case "scope list":
      return (runtime) => ({ scopes: runtime.scopeList() });
    case "scope key":
      usage(() => checkScopeName(first));
      return (runtime) => runtime.scopeKey(first);
    case "scope share":
      usage(() => checkScopeName(first));
      if (options.access === undefined) throw Object.assign(new Error("scope share takes --access read, which gives the key to read and post, or --access write, which gives the address to post only."), { code: "usage" });
      usage(() => checkAccess(options.access));
      return (runtime) => runtime.scopeShare(first, second, options.access);
    case "scope remove":
      usage(() => checkScopeName(first));
      return (runtime) => runtime.scopeRemove(first);
    default:
      throw new Error("unknown command " + command);
  }
}

const ADDON_HELP = `Usage: aamio [--home DIR] addon <command>

  list                 The add-ons installed in this home's folder for add-ons, and which of them run here
  enable NAME          Let an installed add-on run here, by its short name or its package
  disable NAME         Take an add-on out again
  NAME COMMAND ...     A command of an add-on that runs here: aamio addon NAME --help lists them

An add-on is installed with npm in addon-packages/npm under the home. Listing
runs nothing of it. enable starts its process once, to see that it answers as
its manifest says, and records the choice in addons.json in the home.
`;

/**
 * aamio addon ...: the exit code. list, enable and disable read the home's
 * folders and files and open no runtime: a list of a home that is not there
 * leaves it not there. An add-on's own command runs in a process of the
 * add-on's, with the home open for it unless its manifest says it needs none.
 */
async function addon(home, words, archive) {
  const [first, ...rest] = words;
  const say = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  const refuse = (message, code) => {
    process.stderr.write(`aamio: ${message}\n`);
    return code;
  };
  if (first === undefined || ["--help", "-h", "help"].includes(first)) {
    (first === undefined ? process.stderr : process.stdout).write(ADDON_HELP);
    return first === undefined ? 2 : 0;
  }
  const core = { coreTools: RUNTIME_TOOL_NAMES };
  try {
    if (first === "list") {
      if (rest.length) return refuse("addon list takes no arguments.", 2);
      const answer = await describe(home, core);
      say(answer);
      // What is broken is in the list, with the command that takes it out.
      return answer.error ? 1 : 0;
    }
    if (first === "enable" || first === "disable") {
      if (rest.length !== 1 || rest[0].startsWith("-")) return refuse(`addon ${first} takes one add-on, by its short name or its package.`, 2);
      // An identity is made only in a folder that is not there yet, so a home
      // that got its add-on first can never get one as it is. Said here, where
      // the user can still put it right, and not by the first command that
      // needs the key, which could only say that the key is missing.
      if (first === "enable" && existsSync(home) && !existsSync(join(home, "key"))) {
        return refuse(`${home} has no identity yet, and aamio makes one only in a folder that is not there. Nothing was enabled. Move ${home} aside, run aamio --home "${home}" init, ` +
          "move addon-packages from the folder you moved into the new home, and enable the add-on again.", 2);
      }
      try {
        say(first === "enable" ? await enable(home, rest[0], { ...core, probe }) : await disable(home, rest[0], core));
      } catch (failure) {
        if (!(failure instanceof AddonError)) throw failure;
        return refuse(failure.message, 2);
      }
      return 0;
    }
    const manifest = (await loaded(home, core)).find((held) => held.NAME === first);
    if (!manifest) {
      const there = (await describe(home, core)).addons.some((row) => row.name === first || row.distribution === first);
      return refuse(there ? `the add-on ${first} is installed and not enabled. aamio addon enable ${first} lets it run here.`
        : `no add-on called ${first} runs here. aamio addon list says which are installed in this home.`, 2);
    }
    const parsed = parseCommand(manifest, rest);
    if (parsed.help) {
      (parsed.asked ? process.stdout : process.stderr).write(usageOf(manifest));
      return parsed.asked ? 0 : 2;
    }
    const options = { stderr: (text) => process.stderr.write(text) };
    let done;
    if (!parsed.needsRuntime) {
      done = await runCommand(manifest, parsed, null, options);
    } else {
      await initIdentity(home);
      const runtime = await NodeRuntime.open({ home, archive });
      try {
        done = await runCommand(manifest, parsed, runtime, options);
      } finally {
        await runtime.close();
      }
    }
    // The bytes as they are, for a command that answers with a file.
    if (done.raw !== undefined) process.stdout.write(done.raw);
    else if (done.out !== undefined) say(done.out);
    return done.code;
  } catch (failure) {
    if (failure instanceof AddonError) return refuse(failure.message, 1);
    throw failure;
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
  const { command, home, archive } = options;
  if (command === "help") process.stdout.write(help);
  else if (command === "version") process.stdout.write(version + "\n");
  else if (command === "addon") return addon(home, options.words, archive);
  else if (command === "serve") {
    // The add-ons enabled in this home, read before the home is taken: one
    // that cannot be used stops the start and says so, a quiet absence would
    // be a tool the user enabled and the model never sees.
    let addons;
    try {
      addons = await loaded(home, { coreTools: RUNTIME_TOOL_NAMES });
      // Enabled here and not installed any more: the server starts without
      // it, and says so on standard error, where the app that started it
      // keeps its log. Standard output is the protocol's alone.
      for (const gone of await enabledButMissing(home)) {
        process.stderr.write(`aamio: the add-on ${gone} is enabled in this home and not installed there any more, so its tools are not offered. Install it again with ${installWords(home, gone)}, or take it out with aamio addon disable ${gone}.\n`);
      }
    } catch (failure) {
      if (!(failure instanceof AddonError)) throw failure;
      process.stderr.write(`aamio: ${failure.message}\n`);
      return 1;
    }
    await initIdentity(home);
    // One live runtime per home, Node, Python or PHP: serve holds the home,
    // owner.lock and all, for as long as it runs, as the other servers do.
    const runtime = await NodeRuntime.open({ home, archive });
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
      await serveMcp({ home, version, runtime, addons });
    } finally {
      clearInterval(keepalive);
      await runtime.serial(() => runtime.close());
    }
  } else if (command === "init" || command === "whoami") {
    const identity = command === "init" ? await initIdentity(home) : await readIdentity(home);
    // Said once, where a person sets the runtime up: the service forgets,
    // and this folder does not unless it is told to.
    if (command === "init") identity.local_storage = { ...(await archiveStatus(home, await readPolicy(home))), home };
    process.stdout.write(JSON.stringify(identity) + "\n");
  } else {
    const act = plan(command, options.positional, options.options);
    await initIdentity(home);
    const runtime = await NodeRuntime.open({ home, archive });
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
      "board_failed", "board_unreachable", "board_inbox_unavailable", "unknown_post", "not_saved", "unknown_channel", "receipt_failed", "no_trace",
      "invalid_scope", "invalid_access", "scope_exists", "unknown_scope", "scope_write_only",
      "invalid_label", "invalid_gate", "invalid_ttl", "invalid_note", "invalid_address", "invalid_archive", "channel_exists", "channel_unavailable", "binding_conflict"];
    process.stderr.write((known.includes(error?.code) ? error.message + (error.fix ? ` ${error.fix}` : "") : "The local Node runtime could not complete this command.") + "\n");
    process.exitCode = 1;
  }
}
