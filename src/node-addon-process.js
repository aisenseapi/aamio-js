import { spawn } from "node:child_process";
import { keyHash } from "./aamio.js";
import {
  AddonError, CORE_VERSION, HOST_COMMANDS, Refused, allowHost, allowedHosts, dest, forgetHost, isSameHost, normaliseHost, notAllowed, refusal, stateDir, subjectFields, subjectFor,
} from "./node-addons.js";

/*
 * One call to an add-on: a process of the add-on's own, started for the call
 * and gone when it has answered. The request goes to its standard input as
 * one JSON document, the answer comes from its standard output as one, and a
 * deadline holds whatever the process does. An add-on that hangs, crashes or
 * floods becomes an answer that says so, and the runtime and its MCP server
 * go on. Nothing an add-on answers changes state here.
 *
 * Before the process starts the core settles what is the core's: the website
 * a call would read is on the user's list or the user is asked, and the name
 * a call gives is resolved to a key from the address book or from a message
 * this process verified. The add-on is given that key, and never a name it
 * could look up itself.
 */

export const PROBE_DEADLINE = 20;
export const MAX_AT_ONCE = 2;
export const MAX_PER_WINDOW = 20;
export const WINDOW_SECONDS = 60;
// The question a tool asks, under this name in inputRequests, for a website that is not on the user's list.
export const HOST_QUESTION = "aamio_addon_host";
// The most an answer may be, and the most standard error may carry: a process
// that streams past either is stopped while it runs, not read to the end.
export const MAX_ANSWER_BYTES = 1_000_000;
export const MAX_STDERR_BYTES = 65_536;
// How long a stopped process gets to go away before it is given up on.
export const STOP_WAIT = 5;
// What the process gets of the environment: what the interpreter, the path, a
// temporary directory, the locale, TLS roots and a proxy need, and nothing
// else. A token in the user's environment is not the add-on's to read, unless
// its manifest names it, and then aamio addon list says so before it is
// enabled. The proxy variables can carry credentials of their own.
export const ENVIRONMENT = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Node goes through the proxy these name only when NODE_USE_ENV_PROXY says
  // so: the user's own word about the same proxy, and it goes with them.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY",
]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// ------------------------------------------------------------------- limits

/** At most so many calls of one add-on at once, and so many started per minute: a process per call is a cost, and a model can loop. */
class Limits {
  constructor() {
    this.atOnce = 0;
    this.started = [];
  }

  take(now = Date.now() / 1000) {
    while (this.started.length && now - this.started[0] > WINDOW_SECONDS) this.started.shift();
    if (this.atOnce >= MAX_AT_ONCE) return "addon_busy";
    if (this.started.length >= MAX_PER_WINDOW) return "addon_rate";
    this.atOnce += 1;
    this.started.push(now);
    return null;
  }

  giveBack() {
    this.atOnce = Math.max(0, this.atOnce - 1);
  }
}

const LIMITS = new Map();

export function limitsOf(name) {
  if (!LIMITS.has(name)) LIMITS.set(name, new Limits());
  return LIMITS.get(name);
}

/**
 * The add-on's own directory for this call, or the answer that says it could
 * not be made: a home whose disk is full or whose addons folder is in the way
 * stops the call before the process starts, as an answer like any other.
 */
async function ownDirectory(runtime, manifest) {
  try {
    return [await stateDir(runtime.home, manifest), null];
  } catch (error) {
    return [null, failure(manifest, "addon_failed", `the add-on ${manifest.NAME} has no directory of its own: addons/${manifest.NAME} in the home could not be made (${error.code || error.message}). Nothing of the add-on ran. Check the disk and the home's permissions.`)];
  }
}

const busyRefusal = (manifest, busy) => new Refused(busy, `At most ${MAX_AT_ONCE} calls of the add-on ${manifest.NAME} run at once and ${MAX_PER_WINDOW} start per minute here. Nothing was done. Try again shortly.`, "unreachable");

// ------------------------------------------------------------------ process

function failure(manifest, reason, fix) {
  return { result: { status: "unreachable", reason, fix, addon: manifest.NAME }, exit_code: 5, is_error: true };
}

/** What the process gets of the environment: the short list, and what its manifest declared it reads, when set and when this is a call and not the probe at enable. Never the home or the user's rest. */
// Set for the process on Windows, so that a program it starts by a bare name
// is not looked for in the working directory.
export const NO_CURRENT_DIRECTORY = "NoDefaultCurrentDirectoryInExePath";

export function childEnvironment(manifest, declared, from = process.env, windows = process.platform === "win32") {
  const env = {};
  for (const [key, value] of Object.entries(from)) {
    if (value === undefined) continue;
    if (ENVIRONMENT.has(key.toUpperCase()) || (declared && manifest.environment.includes(key))) env[key] = value;
  }
  env.AAMIO_ADDON = "2";
  // Last, after what the manifest declared, and whatever case it came in: on
  // Windows the process does not look in the working directory for a program
  // it starts by a bare name (a security review of 13 November 2026). The
  // add-ons start theirs by a full path as well; this is for anything else.
  if (windows) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === NO_CURRENT_DIRECTORY.toUpperCase()) delete env[key];
    env[NO_CURRENT_DIRECTORY] = "1";
  }
  return env;
}

/**
 * One call to the add-on's process: the request on its standard input, its
 * answer from standard output, within the deadline.
 *
 * stderr is a function given what the process wrote to standard error, or
 * null to drop it. declared false keeps the variables the manifest asks for
 * out of the environment: the probe at enable runs so, before the user has
 * seen the names in aamio addon list. The answer is always an object with
 * result or raw, exit_code and is_error; a process that cannot be started,
 * answers nothing this aamio can read or runs past the deadline becomes an
 * unreachable result with the reason, and the deadline kills it. It is
 * answered once, whichever of those comes first, and never throws.
 */
export function run(manifest, kind, name, args, { subject = null, ownKey = null, stateDirectory = null, stderr = null, deadline = null, declared = true, limits = {} } = {}) {
  const seconds = deadline ?? manifest.deadline;
  const mostOut = limits.answer ?? MAX_ANSWER_BYTES;
  const mostErr = limits.stderr ?? MAX_STDERR_BYTES;
  const stopWait = limits.stop ?? STOP_WAIT;
  const request = JSON.stringify({
    aamio_addon: 2, kind, name, arguments: args, subject, own_key: ownKey, state_dir: stateDirectory, deadline_seconds: seconds,
    aamio: { version: CORE_VERSION, runtime: "node" },
  });
  const stop = `Reinstall it, or aamio addon disable ${manifest.NAME} to go on without it.`;
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    // Why the process was stopped, once it has been: the answer is that, whatever it wrote before.
    let stopped = null;
    let child = null;
    let timer = null;
    let lastWait = null;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(lastWait);
      resolve(answer);
    };
    const kill = (reason, fix) => {
      if (stopped !== null || settled) return;
      stopped = [reason, fix];
      try {
        child.kill("SIGKILL");
      } catch {
        // Gone already.
      }
      // A stopped process gets a moment to go away. One that does not, or
      // that left its pipes with a process of its own, is given up on: the
      // call is answered, and what is left is the system's.
      lastWait = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
        finish(failure(manifest, reason, fix));
      }, stopWait * 1000);
    };
    try {
      // The script by its real path, with this Node, no shell between, and an
      // environment made here: nothing of the parent's is inherited.
      child = spawn(process.execPath, [manifest.entry], { shell: false, env: childEnvironment(manifest, declared), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      finish(failure(manifest, "addon_failed", `the process of the add-on ${manifest.NAME} could not be started: ${error.message}. ${stop}`));
      return;
    }
    // Both streams are listened to, and measured, before anything is written
    // to the process: a process that answers at once is measured like a slow one.
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > mostOut) kill("addon_failed", `the add-on ${manifest.NAME} wrote more than the ${mostOut} bytes an answer may be, and was stopped. ${stop}`);
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errBytes += chunk.length;
      if (errBytes > mostErr) kill("addon_failed", `the add-on ${manifest.NAME} wrote more than ${mostErr} bytes to standard error, and was stopped. ${stop}`);
      else err.push(chunk);
    });
    // A process that does not read its request, or that is gone before it
    // was written, breaks the pipe: that is not a failure of its own, and
    // what the process answered or did not answer says the rest.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      if (stopped === null) finish(failure(manifest, "addon_failed", `the process of the add-on ${manifest.NAME} could not be started: ${error.message}. ${stop}`));
    });
    timer = setTimeout(() => {
      kill("addon_timeout", `the add-on ${manifest.NAME} did not answer within ${seconds} seconds and was stopped. Nothing else here was affected. Try again, or run the command by hand to see what it does.`);
    }, seconds * 1000);
    child.on("close", (code) => {
      if (stopped !== null) {
        finish(failure(manifest, ...stopped));
        return;
      }
      const text = Buffer.concat(err).toString("utf8");
      if (stderr !== null && text) stderr(text);
      let answer;
      try {
        // The mark is kept, so an answer with a byte order mark in front is
        // not JSON here, as it is not in aamio-python and aamio-php.
        answer = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(out)));
        if (!isObject(answer)) throw new Error("not an object");
      } catch {
        const said = text.trim().split(/\r?\n/).filter(Boolean);
        finish(failure(manifest, "addon_failed", `the add-on ${manifest.NAME} exited with code ${code} and gave no answer this aamio can read${said.length ? ": " + said[said.length - 1].slice(0, 200) : ""}. ${stop}`));
        return;
      }
      let exit = "exit_code" in answer ? answer.exit_code : (code === 0 ? 0 : code);
      if (!Number.isInteger(exit) || exit < 0 || exit > 255) exit = 1;
      const normal = { exit_code: exit, is_error: Boolean("is_error" in answer ? answer.is_error : exit !== 0) };
      if (typeof answer.raw === "string") {
        if (!BASE64.test(answer.raw)) {
          finish(failure(manifest, "addon_failed", `the add-on ${manifest.NAME} answered with raw bytes that are not base64. ${stop}`));
          return;
        }
        normal.raw = Buffer.from(answer.raw, "base64");
      } else {
        normal.result = answer.result ?? null;
      }
      if (typeof answer.stderr === "string" && answer.stderr && stderr !== null) stderr(answer.stderr.endsWith("\n") ? answer.stderr : answer.stderr + "\n");
      finish(normal);
    });
    child.stdin.end(request);
  });
}

/**
 * What enable asks before anything is recorded: the process starts, speaks
 * the protocol, and is the add-on the manifest says. It runs with the short
 * list of environment variables and none the manifest asks for: the user sees
 * those names in aamio addon list before anything of the add-on has run, and
 * the first call is what gets them.
 */
export async function probe(manifest, options = {}) {
  const answer = await run(manifest, "probe", "probe", {}, { ...options, deadline: Math.min(manifest.deadline, PROBE_DEADLINE), declared: false });
  const said = answer.result;
  if (!isObject(said) || said.ok !== true) {
    const reason = isObject(said) ? said.reason : null;
    const detail = isObject(said) && ["addon_timeout", "addon_failed"].includes(reason) ? said.fix : `it answered ${String(JSON.stringify(said ?? null)).slice(0, 200)}`;
    throw new AddonError(`the add-on ${manifest.NAME} did not answer the probe: ${detail}`);
  }
  if (said.aamio_addon !== 2 || said.name !== manifest.NAME || said.version !== manifest.version) {
    throw new AddonError(`the add-on ${manifest.NAME} answered the probe as ${said.name} ${said.version} on contract ${said.aamio_addon}, and its manifest says ${manifest.NAME} ${manifest.version} on contract 2. Reinstall it, or ${manifest.fix} to go on without it.`);
  }
}

// --------------------------------------------------------- the command line

const HOST_HELP = {
  allow: ["put a website on this runtime's list, from your own records", [{ name: "host", help: "the host name, as example.org" }]],
  forget: ["take a website off the list", [{ name: "host" }]],
  list: ["the websites this runtime may read for this add-on", []],
};

function declaredOf(manifest, command) {
  if (manifest.hosts !== null && HOST_COMMANDS.includes(command)) return { help: HOST_HELP[command][0], arguments: HOST_HELP[command][1], core: true };
  return Object.hasOwn(manifest.commands, command) ? manifest.commands[command] : null;
}

function shape(argument) {
  if (!argument.name.startsWith("-")) return argument.name.toUpperCase();
  const value = `${argument.name} ${dest(argument.name).toUpperCase()}`;
  return argument.required ? value : `[${value}]`;
}

/** What aamio addon NAME --help prints: the add-on's commands, from its manifest, with nothing of the add-on run. */
export function usageOf(manifest) {
  const lines = [`Usage: aamio addon ${manifest.NAME} <command> [arguments]`, ""];
  if (manifest.description) lines.push(manifest.description, "");
  const rows = manifest.commandNames().map((command) => {
    const spec = declaredOf(manifest, command);
    return [[command, ...(spec.arguments ?? []).map(shape)].join(" "), spec.help ?? ""];
  });
  const width = Math.min(44, Math.max(0, ...rows.map(([words]) => words.length)));
  for (const [words, help] of rows) lines.push(`  ${words.padEnd(width)}  ${help}`.trimEnd());
  for (const command of manifest.commandNames()) {
    const helped = (declaredOf(manifest, command).arguments ?? []).filter((argument) => argument.help);
    if (helped.length) lines.push("", `${command}:`, ...helped.map((argument) => `  ${argument.name.padEnd(18)}  ${argument.help}`));
  }
  return lines.join("\n") + "\n";
}

const usage = (message) => Object.assign(new Error(message), { code: "usage" });

/**
 * The words after aamio addon NAME, read against the manifest: which command,
 * and each of its arguments by the name the request carries it under. An
 * option takes one value, --name value or --name=value, and one left out is
 * null. Throws a usage error for what the command does not take.
 */
export function parseCommand(manifest, words) {
  const [command, ...rest] = words;
  if (command === undefined || ["--help", "-h", "help"].includes(command)) return { help: true, asked: command !== undefined };
  const spec = declaredOf(manifest, command);
  if (spec === null) throw usage(`aamio addon ${manifest.NAME} has no command ${command}. It has: ${manifest.commandNames().join(", ")}.`);
  const list = spec.arguments ?? [];
  const options = list.filter((argument) => argument.name.startsWith("-"));
  const positional = list.filter((argument) => !argument.name.startsWith("-"));
  const values = Object.fromEntries(list.map((argument) => [dest(argument.name), null]));
  const given = [];
  let ended = false;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (!ended && word === "--") {
      ended = true;
    } else if (!ended && (word === "--help" || word === "-h")) {
      return { help: true, asked: true };
    } else if (!ended && word.startsWith("--")) {
      const [name, inline] = word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined];
      if (!options.some((option) => option.name === name)) throw usage(`aamio addon ${manifest.NAME} ${command} does not take ${name}. Run aamio addon ${manifest.NAME} --help for usage.`);
      const value = inline ?? rest[++i];
      if (value === undefined) throw usage(`${name} needs a value.`);
      values[dest(name)] = value;
    } else {
      given.push(word);
    }
  }
  if (given.length !== positional.length) {
    throw usage(`aamio addon ${manifest.NAME} ${command} takes ${positional.length ? positional.map((argument) => argument.name.toUpperCase()).join(" ") : "no arguments"}${options.length ? " and " + options.map(shape).join(" ") : ""}. Run aamio addon ${manifest.NAME} --help for usage.`);
  }
  positional.forEach((argument, index) => { values[dest(argument.name)] = given[index]; });
  const missing = options.filter((option) => option.required && values[dest(option.name)] === null);
  if (missing.length) throw usage(`aamio addon ${manifest.NAME} ${command} needs ${missing.map((option) => option.name).join(" and ")}.`);
  return { help: false, command, spec, values, core: spec.core === true, needsRuntime: spec.core === true || spec.runtime !== false };
}

/**
 * One command of an add-on, as the command line runs it: what to print and
 * the exit code. runtime is the open runtime, or null for a command whose
 * manifest says it runs without one: the process is started all the same,
 * with no directory of its own. out is the JSON to print, raw the bytes to
 * write as they are; one of them, or neither.
 */
export async function runCommand(manifest, parsed, runtime, { stderr = null, limits } = {}) {
  const { command, spec, values } = parsed;
  if (parsed.core) {
    try {
      if (command === "allow") return { code: 0, out: { ...(await allowHost(runtime, manifest, values.host)), note: `This runtime may now read this website for the add-on ${manifest.NAME} when a call asks for it. Nothing was read now.` } };
      if (command === "forget") return { code: 0, out: await forgetHost(runtime, manifest, values.host) };
      return { code: 0, out: { hosts: await allowedHosts(runtime, manifest) } };
    } catch (refused) {
      if (!(refused instanceof Refused)) throw refused;
      return { code: 2, out: refusal(refused) };
    }
  }
  const args = { ...values };
  let subject = null;
  let ownKey = null;
  let host = null;
  try {
    for (const argument of spec.arguments ?? []) {
      const called = dest(argument.name);
      if (argument.host && args[called] !== null) {
        host = args[called] = normaliseHost(args[called]);
        if (!(await allowedHosts(runtime, manifest)).includes(host)) throw notAllowed(manifest, host);
      }
      if (argument.subject && args[called] !== null) subject = subjectFor(runtime, argument.subject, args[called]);
    }
    if ((spec.needs ?? []).includes("own_key")) ownKey = runtime.keys.public;
  } catch (refused) {
    if (!(refused instanceof Refused)) throw refused;
    return { code: 2, out: refusal(refused, { host, ...subjectFields(subject) }) };
  }
  const [directory, noDirectory] = runtime !== null ? await ownDirectory(runtime, manifest) : [null, null];
  if (noDirectory !== null) return { code: noDirectory.exit_code, out: noDirectory.result };
  const held = limitsOf(manifest.NAME);
  const busy = held.take();
  if (busy !== null) return { code: 5, out: refusal(busyRefusal(manifest, busy), { host }) };
  let answer;
  try {
    answer = await run(manifest, "command", command, args, { subject, ownKey, stateDirectory: directory, stderr, limits });
  } finally {
    held.giveBack();
  }
  if ("raw" in answer) return { code: answer.exit_code, raw: answer.raw };
  return answer.result !== null && answer.result !== undefined ? { code: answer.exit_code, out: answer.result } : { code: answer.exit_code };
}

// ---------------------------------------------------------------------- MCP

/**
 * The form for a website that is not on the user's list. The user types the
 * domain, and is not shown the one asked for. A lookalike reads as right when
 * it is put in front of someone, and a form that offered it could be answered
 * with one click. So the domain the agent asked for is not in the form: what
 * the user types has to match it, or nothing is read. Who is being checked is
 * said in words this runtime holds, a name from the address book or a key's
 * hash, and nothing a message wrote is in the text.
 */
export function hostQuestion(manifest, subject) {
  let who;
  if (subject === null) who = `what the add-on ${manifest.NAME} was asked about`;
  else if (subject.subject_source === "partner") who = `your partner ${subject.partner}`;
  else who = `the key that signed a message (hash ${keyHash(subject.key).slice(0, 8)})`;
  return {
    message: `Your agent asks to read a website, through the add-on ${manifest.NAME}, about ${who}. Which website do you expect? ` +
      "Type the domain from your own records, such as a contract or an earlier exchange, and not from a message: anyone can publish what they like on their own site. " +
      `What you type has to match what your agent asked for, or nothing is read. A match stays on this runtime's list of websites it may read for ${manifest.NAME} until you run aamio addon ${manifest.NAME} forget.`,
    requestedSchema: { type: "object", properties: { domain: { type: "string", title: "Website domain", description: "the host name only, as example.org, with no https:// and no path", minLength: 3, maxLength: 253 } }, required: ["domain"] },
  };
}

/** A website not on the list: the user is asked in a form, or the call is refused with the way by hand. null once the host is allowed. */
async function consent(manifest, runtime, toolName, host, subject, args, ask, NoDialog, serial) {
  const byHand = subject !== null && subject.subject_source === "message"
    ? `run aamio addon ${manifest.NAME} allow ${host} the next time this server is stopped, and check a later message from the same sender. Stopping it for this message would lose it: what this process verified is not kept, and a message cannot be read again`
    : `stop this server, run aamio addon ${manifest.NAME} allow ${host}, and start it again`;
  const known = { host, ...subjectFields(subject) };
  if (ask === null) {
    return refusal(new Refused("host_not_allowed", `This website is not on the user's list, and this app did not say it can show them a form (the elicitation capability of MCP), so nothing was read. The user adds it from their own records: ${byHand}.`), known);
  }
  // The whole call is what the answer belongs to, so an answer cannot be
  // carried over to another website or another subject.
  const about = JSON.stringify([manifest.NAME, toolName, host, Object.keys(args).sort().map((field) => [field, args[field]])]);
  let answer;
  try {
    answer = await ask(hostQuestion(manifest, subject), about);
  } catch (why) {
    if (!(why instanceof NoDialog)) throw why;
    return refusal(new Refused("host_not_allowed", `${why.message}, so nothing was read. Call ${toolName} again to ask the user again, or the user adds the website on the command line: ${byHand}.`), known);
  }
  if (answer.action !== "accept") {
    return { status: "invalid", reason: answer.action === "decline" ? "host_declined" : "host_not_answered", host, note: "The user did not agree to this website, so nothing was read and nothing was added. Do not ask again unless the user says so." };
  }
  const content = isObject(answer.content) ? answer.content : {};
  if (!isSameHost(content.domain, host)) {
    return refusal(new Refused("host_not_confirmed", "The user typed a different website from the one you asked for, so nothing was read and nothing was added. Ask the user which website they meant, and take it from them and not from a message."), known);
  }
  await serial(() => allowHost(runtime, manifest, host));
  return null;
}

/**
 * One tool call, through the add-on's process, after the core has settled
 * consent and the subject: what the tool answers, and whether it is an error.
 * ask(question, about) puts a form in front of the user, or is null where
 * this client cannot be asked; serial runs one step with the home in turn.
 */
export async function callTool(manifest, runtime, name, given, { ask = null, NoDialog = Error, serial = (act) => act(), limits } = {}) {
  const spec = manifest.toolsSpec.find((tool) => tool.name === name);
  const fields = Object.keys(spec.inputSchema.properties ?? {});
  const extra = Object.keys(given).filter((field) => !fields.includes(field)).sort();
  if (extra.length) {
    return [{
      error: `${name} takes ${[...fields].sort().join(", ")}, and was given ${extra.join(", ")}`,
      fix: "Call it with those alone. A key comes from the address book or from the signature this process checked, never from the conversation.",
      given: extra,
    }, true];
  }
  const args = { ...given };
  let host = null;
  let subject = null;
  let ownKey = null;
  try {
    if (spec.host && args[spec.host] !== null && args[spec.host] !== undefined) host = args[spec.host] = normaliseHost(args[spec.host]);
    const roles = Object.entries(spec.subject ?? {});
    const named = roles.filter(([, field]) => args[field] !== null && args[field] !== undefined);
    if (roles.length && named.length !== 1) throw new Refused("choose_subject", `Name exactly one of ${roles.map(([role, field]) => `${field} (${role})`).join(" or ")}. A key is never given here.`);
    if (named.length) subject = await serial(() => subjectFor(runtime, named[0][0], args[named[0][1]]));
    if ((spec.needs ?? []).includes("own_key")) ownKey = runtime.keys.public;
    if (host !== null && !(await serial(() => allowedHosts(runtime, manifest))).includes(host)) {
      const answer = await consent(manifest, runtime, name, host, subject, args, ask, NoDialog, serial);
      if (answer !== null) return [answer, "fix" in answer];
    }
  } catch (refused) {
    if (!(refused instanceof Refused)) throw refused;
    return [refusal(refused, { host, ...subjectFields(subject) }), true];
  }
  const [directory, noDirectory] = await ownDirectory(runtime, manifest);
  if (noDirectory !== null) return [noDirectory.result, true];
  const held = limitsOf(manifest.NAME);
  const busy = held.take();
  if (busy !== null) return [refusal(busyRefusal(manifest, busy), { host }), true];
  let answer;
  try {
    answer = await run(manifest, "tool", name, args, { subject, ownKey, stateDirectory: directory, limits });
  } finally {
    held.giveBack();
  }
  if ("raw" in answer) return [{ raw_base64: answer.raw.toString("base64") }, answer.is_error];
  return [answer.result, answer.is_error];
}
