import { readFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, relative, sep } from "node:path";
import { pastMark } from "./node-archive.js";
import { holdFile } from "./node-lock.js";

/*
 * Add-ons: what a runtime can do beyond the core, installed one by one and
 * enabled by name.
 *
 * The core is the rendezvous: keys, inbox, presence, the board, receipts.
 * Other things are add-ons, each an npm package of its own that carries a
 * manifest, aamio-addon.json, named in its package.json under aamioAddon, and
 * a script the core runs as a process of the add-on's own for each call: one
 * JSON request on its standard input, one JSON answer on its standard output,
 * and a deadline. That is contract 2 of aamio's add-ons, the same manifest and
 * the same protocol aamio-python and aamio-php speak, written up at
 * https://aamio.at/docs/addons. This runtime knows no other contract: nothing
 * of an add-on is ever loaded into this process.
 *
 * An add-on is installed in a folder of the home's own, addon-packages/npm,
 * with npm: which packages are there does not depend on the folder a command
 * is run in, or on the cache npx started this aamio from. Installed is not
 * enabled. What is installed is listed from package.json and the manifest,
 * running none of it. `aamio addon enable NAME` starts the add-on's process
 * once, to see that it answers as its manifest says, and records the choice in
 * addons.json in the home, where aamio-python and aamio-php keep theirs. An
 * entry of this runtime's is written npm:<package>, so a package on npm and a
 * distribution on PyPI that share a name are two choices, each made for the
 * code it names, and the other clients' entries are left as they are.
 *
 * The core keeps what is the core's: the key, the home and its lock, the
 * address book, the messages this process verified, and the user's consent to
 * the websites an add-on may read. The add-on gets the call's arguments, a
 * subject the core resolved to a key, a directory of its own, and a short
 * list of environment variables rather than the user's. It is not a sandbox:
 * the process runs as the same user and reads what the user reads.
 */

export const CORE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const MANIFEST_FIELD = "aamioAddon";
export const ENABLED_FILE = "addons.json";
// An entry of this runtime's in addons.json: a package of npm's.
export const PREFIX = "npm:";
export const KNOWN_CONTRACTS = [2];
export const DEADLINE_DEFAULT = 30;
export const DEADLINE_MAX = 120;
// The consent list lives beside the add-on's own directory, not in it: the
// add-on's process must not be able to widen what it may read.
export const HOSTS_SUFFIX = ".hosts.json";
export const HOST_COMMANDS = ["allow", "forget", "list"];
// Commands of aamio addon itself, which no add-on may be called.
export const RESERVED = ["list", "enable", "disable", "run"];
// Names an add-on may not ask for in its environment list.
export const NEVER_PASSED = ["AAMIO_HOME", "AAMIO_ADDONS", "AAMIO_ADDON"];
// How long a change waits for another aamio that is changing the same list.
export const LOCK_WAIT = 10;
export const RESTART = "A local MCP server already running keeps the tools it started with: start it again to see the change.";

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Names Windows takes for a device. An add-on's short name is the name of its
// list of websites and of its own directory in the home.
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const COMMAND = /^[a-z][a-z0-9-]{0,31}$/;
const POSITIONAL = /^[a-z][a-z0-9_-]{0,31}$/;
const OPTION = /^--[a-z][a-z0-9-]{0,31}$/;
const VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
// A package's name as npm takes it, with or without a scope. Each part starts
// with a letter, a digit, a dash or a tilde, so none of them is a way out of
// node_modules.
const PACKAGE = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;
// The script a manifest names: a file of the package's, in JavaScript.
const SCRIPT = /\.(?:js|mjs|cjs)$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An add-on that cannot be used as one, with what to do about it. */
export class AddonError extends Error {
  constructor(message) {
    super(message);
    this.code = "addon";
  }
}

/** A call settled before the add-on's process starts: a bad argument, no such subject, a website the user has not agreed to. */
export class Refused extends Error {
  constructor(reason, fix, status = "invalid") {
    super(fix);
    this.reason = reason;
    this.fix = fix;
    this.status = status;
  }
}

export function refusal(refused, known = {}) {
  const answer = { status: refused.status, reason: refused.reason, fix: refused.fix };
  for (const [field, value] of Object.entries(known)) if (value !== null && value !== undefined) answer[field] = value;
  return answer;
}

/** The name of an argument as the request carries it: --reply-to is reply_to. */
export function dest(name) {
  return name.replace(/^-+/, "").replaceAll("-", "_");
}

// ---------------------------------------------------------------- installed

/** The folder of the home's own that add-ons are installed in with npm. */
export function addonRoot(home) {
  return join(home, "addon-packages", "npm");
}

/** How an add-on is installed here, for the messages that say so. */
export function installWords(home, name = "aamio-domain-keys") {
  return `npm install --prefix "${addonRoot(home)}" --ignore-scripts ${name}`;
}

/**
 * Every add-on installed in the home's folder for add-ons, from package.json
 * and without running any of it: the packages that folder's own package.json
 * depends on, which is what npm install put there by name, and of those the
 * ones whose package.json names a manifest. What another package brought with
 * it is not an add-on of this home's. A home that has no such folder has none.
 */
export async function installed(home) {
  const root = addonRoot(home);
  let top;
  try {
    top = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw new AddonError(`${join(root, "package.json")} could not be read: ${error.code || error.message}. It lists the add-ons installed in this home. Fix or remove the file, and install the add-ons again: ${installWords(home)}.`);
  }
  const names = new Set();
  for (const field of ["dependencies", "optionalDependencies"]) {
    if (isObject(top) && isObject(top[field])) for (const name of Object.keys(top[field])) if (PACKAGE.test(name)) names.add(name);
  }
  const rows = [];
  for (const distribution of [...names].sort()) {
    const dir = join(root, "node_modules", ...distribution.split("/"));
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    } catch {
      // Named and not there, or not a package: nothing is installed under that name.
      continue;
    }
    if (!isObject(pkg) || !(MANIFEST_FIELD in pkg)) continue;
    rows.push({ distribution, version: typeof pkg.version === "string" ? pkg.version : null, dir, declared: pkg[MANIFEST_FIELD] });
  }
  return rows;
}

/**
 * A file of the package's, by the path the package gives for it: the real
 * path, when that is a file inside the package's own real folder. A path out
 * of the package, by .. or by a link, is refused, and so is a folder.
 */
async function inside(row, given, what, fix) {
  const wrong = (why) => new AddonError(`the add-on ${row.distribution} cannot be used: ${what} ${why}. Reinstall it, or ${fix} to go on without it.`);
  if (typeof given !== "string" || !given || given.includes("\0") || isAbsolute(given)) throw wrong("is not a path inside the package");
  let root;
  let real;
  try {
    root = await realpath(row.dir);
    real = await realpath(join(root, given));
  } catch (error) {
    throw wrong(`(${given}) is not there: ${error.code || error.message}`);
  }
  const from = relative(root, real);
  if (!from || from === ".." || from.startsWith(".." + sep) || isAbsolute(from)) throw wrong(`(${given}) is outside the package`);
  if (!(await stat(real)).isFile()) throw wrong(`(${given}) is not a file`);
  return real;
}

// ----------------------------------------------------------------- manifest

/**
 * What an add-on offers, as its manifest says it: its short name, its
 * commands and its tools, the script to run, and what it asks the core for.
 * Everything is checked here, before the add-on is used or recorded.
 */
export class Manifest {
  constructor(distribution, path, data, fix) {
    this.distribution = distribution;
    this.path = path;
    this.fix = fix;
    this.NAME = data.name;
    this.version = data.version;
    this.script = isObject(data.process) ? data.process.node : undefined;
    this.deadline = data.deadline_seconds === undefined ? DEADLINE_DEFAULT : data.deadline_seconds;
    this.description = data.description ?? null;
    this.environment = data.environment ?? [];
    this.hosts = data.hosts;
    this.commands = data.commands ?? {};
    this.toolsSpec = data.tools ?? [];
    // The script's real path, set once it is found inside the package.
    this.entry = null;
    this.validate();
    this.tools = this.toolsSpec.map((spec) => ({
      name: spec.name, description: spec.description, inputSchema: spec.inputSchema, ...(spec.annotations !== undefined && spec.annotations !== null ? { annotations: spec.annotations } : {}),
    }));
  }

  wrong(what) {
    throw new AddonError(`${this.distribution} cannot be used as an add-on: ${what}. Reinstall it, or ${this.fix} to go on without it.`);
  }

  validate() {
    if (typeof this.NAME !== "string" || !NAME.test(this.NAME)) this.wrong("its manifest has no name of 1 to 32 characters of a-z, 0-9, dash and underscore");
    if (RESERVED.includes(this.NAME)) throw new AddonError(`${this.distribution} cannot be called ${this.NAME}: that is a command of aamio addon itself. To go on without it: ${this.fix}.`);
    // On Windows a file of that name is the device: a list of websites written to nul.hosts.json is written nowhere.
    if (DEVICE.test(this.NAME)) this.wrong(`its manifest's name, ${this.NAME}, is one Windows keeps for a device, and it names the add-on's files in the home`);
    if (typeof this.version !== "string" || !this.version) this.wrong("its manifest has no version");
    if (typeof this.script !== "string" || !SCRIPT.test(this.script)) this.wrong("its manifest names no JavaScript file to run under process.node");
    if (!Number.isInteger(this.deadline) || this.deadline < 1 || this.deadline > DEADLINE_MAX) this.wrong(`deadline_seconds in its manifest is not a whole number from 1 to ${DEADLINE_MAX}`);
    if (this.description !== null && typeof this.description !== "string") this.wrong("description in its manifest is not text");
    if (!Array.isArray(this.environment) || this.environment.some((name) => typeof name !== "string" || !VARIABLE.test(name))) {
      this.wrong("environment in its manifest is not a list of variable names in A-Z, 0-9 and underscore");
    }
    const never = this.environment.filter((name) => NEVER_PASSED.includes(name));
    if (never.length) this.wrong(`environment in its manifest asks for ${never.join(", ")}, which no add-on gets`);
    if (this.hosts === true) this.hosts = {};
    if (this.hosts !== undefined && this.hosts !== null && this.hosts !== false) {
      if (!isObject(this.hosts)) this.wrong("hosts in its manifest is neither true nor an object");
      const legacy = this.hosts.legacy_file;
      if (legacy !== undefined && legacy !== null && (typeof legacy !== "string" || !legacy || /[\\/\0]/.test(legacy) || legacy === "." || legacy === "..")) {
        this.wrong("hosts.legacy_file in its manifest is not a plain file name");
      }
    } else {
      this.hosts = null;
    }
    if (!isObject(this.commands)) this.wrong("commands in its manifest is not an object");
    for (const [name, spec] of Object.entries(this.commands)) {
      if (!COMMAND.test(name)) this.wrong(`the command ${JSON.stringify(name)} in its manifest is not a name of a-z, 0-9 and dashes`);
      if (this.hosts !== null && HOST_COMMANDS.includes(name)) this.wrong(`its manifest has a command ${name}, which aamio provides for an add-on with hosts`);
      if (!isObject(spec)) this.wrong(`the command ${name} in its manifest is not an object`);
      if (spec.help !== undefined && typeof spec.help !== "string") this.wrong(`the help of the command ${name} is not text`);
      if (spec.runtime !== undefined && typeof spec.runtime !== "boolean") this.wrong(`runtime on the command ${name} is not true or false`);
      const needs = spec.needs ?? [];
      if (!Array.isArray(needs) || needs.some((need) => need !== "own_key")) this.wrong(`needs on the command ${name} names something other than own_key`);
      if (needs.length && spec.runtime === false) this.wrong(`the command ${name} needs own_key and says it runs without a runtime`);
      this.checkArguments(name, spec);
    }
    if (!Array.isArray(this.toolsSpec)) this.wrong("tools in its manifest is not a list");
    const seen = new Set();
    for (const spec of this.toolsSpec) {
      if (!isObject(spec) || typeof spec.name !== "string" || !spec.name) this.wrong("a tool of its has no name");
      if (seen.has(spec.name)) this.wrong(`its manifest has two tools called ${spec.name}`);
      seen.add(spec.name);
      if (typeof spec.description !== "string" || !spec.description) this.wrong(`the tool ${spec.name} has no description`);
      const schema = spec.inputSchema;
      if (!isObject(schema) || schema.type !== "object" || (schema.properties !== undefined && !isObject(schema.properties))) this.wrong(`the tool ${spec.name} has no inputSchema of type object`);
      const fields = Object.keys(schema.properties ?? {});
      if ("oneOf" in schema || "anyOf" in schema) this.wrong(`the tool ${spec.name} has oneOf or anyOf at the top of its schema, which hosts refuse`);
      const host = spec.host;
      if (host !== undefined && host !== null && (typeof host !== "string" || !fields.includes(host))) this.wrong(`host on the tool ${spec.name} names no field of its schema`);
      if (host !== undefined && host !== null && this.hosts === null) this.wrong(`the tool ${spec.name} has a host field, and the manifest has no hosts`);
      const subject = spec.subject;
      if (subject !== undefined && subject !== null) {
        const roles = isObject(subject) ? Object.entries(subject) : [];
        if (!roles.length || roles.some(([role, field]) => !["partner", "message"].includes(role) || typeof field !== "string" || !fields.includes(field))) {
          this.wrong(`subject on the tool ${spec.name} is not an object of partner or message to a field of its schema`);
        }
      }
      const needs = spec.needs ?? [];
      if (!Array.isArray(needs) || needs.some((need) => need !== "own_key")) this.wrong(`needs on the tool ${spec.name} names something other than own_key`);
      if (spec.annotations !== undefined && spec.annotations !== null && !isObject(spec.annotations)) this.wrong(`annotations on the tool ${spec.name} is not an object`);
    }
  }

  checkArguments(command, spec) {
    const list = spec.arguments ?? [];
    if (!Array.isArray(list)) this.wrong(`the arguments of the command ${command} are not a list`);
    let hosts = 0;
    let subjects = 0;
    const dests = new Set();
    for (const argument of list) {
      if (!isObject(argument) || typeof argument.name !== "string") this.wrong(`an argument of the command ${command} has no name`);
      const name = argument.name;
      if (name.startsWith("-")) {
        if (!OPTION.test(name)) this.wrong(`the option ${name} of the command ${command} is not --name in a-z, 0-9 and dashes`);
      } else if (!POSITIONAL.test(name)) {
        this.wrong(`the argument ${name} of the command ${command} is not a name in a-z, 0-9, dash and underscore`);
      } else if (argument.required !== undefined && argument.required !== null) {
        this.wrong(`the argument ${name} of the command ${command} is positional, and required is for options`);
      }
      const called = dest(name);
      if (dests.has(called) || called === this.NAME + "_command") this.wrong(`the command ${command} has two arguments that would be called ${called}`);
      dests.add(called);
      if ((argument.help !== undefined && typeof argument.help !== "string") || (argument.required !== undefined && argument.required !== null && typeof argument.required !== "boolean")
        || (argument.host !== undefined && typeof argument.host !== "boolean")) {
        this.wrong(`the argument ${name} of the command ${command} has help, required or host of the wrong kind`);
      }
      if (argument.host) {
        hosts += 1;
        if (this.hosts === null) this.wrong(`the argument ${name} of the command ${command} is a host, and the manifest has no hosts`);
        if (spec.runtime === false) this.wrong(`the argument ${name} of the command ${command} is a host, which needs the runtime the command says it does without`);
      }
      if (argument.subject !== undefined && argument.subject !== null) {
        subjects += 1;
        if (!["partner", "message"].includes(argument.subject)) this.wrong(`subject on the argument ${name} of the command ${command} is neither partner nor message`);
        if (spec.runtime === false) this.wrong(`the argument ${name} of the command ${command} is a subject, which needs the runtime the command says it does without`);
      }
    }
    if (hosts > 1 || subjects > 1) this.wrong(`the command ${command} has more than one host or more than one subject argument`);
  }

  /** The commands under aamio addon NAME, the ones the core adds for an add-on with hosts among them, sorted. */
  commandNames() {
    return [...Object.keys(this.commands), ...(this.hosts !== null ? HOST_COMMANDS : [])].sort();
  }
}

/**
 * The manifest of an installed add-on, read and checked, running nothing of
 * it: the file package.json names, inside the package, and the script the
 * manifest names, inside the package too. A manifest for a contract this
 * aamio does not know is an error that says which.
 */
export async function readManifest(row) {
  const fix = `aamio addon disable ${row.distribution}`;
  const path = await inside(row, row.declared, `the manifest its package.json names under ${MANIFEST_FIELD}`, fix);
  let data;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new AddonError(`the add-on ${row.distribution} has a manifest, ${path}, that cannot be read: ${error.name}: ${error.message}. Reinstall it, or ${fix} to go on without it.`);
  }
  const number = isObject(data) ? data.aamio_addon : undefined;
  if (number !== 2) {
    throw new AddonError(`the add-on ${row.distribution} is written for contract ${JSON.stringify(number ?? null)} of aamio's add-ons, and this aamio (${CORE_VERSION} for Node) knows ${KNOWN_CONTRACTS.join(" and ")}, a process of the add-on's own for each call. Upgrade aamio, or install a version of the add-on for this one; ${fix} goes on without it.`);
  }
  const manifest = new Manifest(row.distribution, path, data, fix);
  // One package, one version: the list shows it before the add-on is enabled,
  // and the probe holds the process to it afterwards.
  if (row.version !== manifest.version) {
    throw new AddonError(`${row.distribution} cannot be used as an add-on: its manifest says version ${manifest.version} and its package.json ${row.version ?? "none"}. Reinstall it, or ${fix} to go on without it.`);
  }
  manifest.entry = await inside(row, manifest.script, "the script its manifest names under process.node", fix);
  return manifest;
}

// ------------------------------------------------------------------ enabled

export function enabledFile(home) {
  return join(home, ENABLED_FILE);
}

/** Every name in the home's list, as the file spells them: this runtime's entries and the other clients'. */
export async function enabledNames(home) {
  const path = enabledFile(home);
  let data;
  try {
    data = JSON.parse(pastMark(await readFile(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw new AddonError(`${path} could not be read: ${error.code || error.message}. Fix or remove the file; it lists the add-ons enabled here, one name each under "enabled".`);
  }
  const names = isObject(data) ? data.enabled : null;
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
    throw new AddonError(`${path} is not a list of enabled add-ons. Fix or remove the file; it has one name each under "enabled".`);
  }
  return names;
}

const entryOf = (distribution) => PREFIX + distribution;
const sameEntry = (name, distribution) => name.toLowerCase() === entryOf(distribution).toLowerCase();
const isEnabled = (row, names) => names.some((name) => sameEntry(name, row.distribution));

/**
 * The enabled list's lock, one per home, held from reading the list to
 * writing it back: the operating system's, as the home's owner lock is, so
 * two commands at once, from this runtime or from aamio-python or aamio-php
 * on the same home, take turns rather than each writing over the other's
 * change. On Windows this runtime holds the file with no sharing, so another
 * client that asks meanwhile is told the list could not be locked and changes
 * nothing, where it would have waited for one of its own kind.
 */
async function withListLock(home, act, { wait = LOCK_WAIT, lock = holdFile } = {}) {
  const path = enabledFile(home) + ".lock";
  const deadline = Date.now() + wait * 1000;
  let holder;
  for (;;) {
    try {
      holder = await lock(home, path);
    } catch (error) {
      throw new AddonError(`${path} could not be locked: ${error.message} Nothing changed.`);
    }
    if (holder !== null) break;
    if (Date.now() >= deadline) throw new AddonError(`${enabledFile(home)} is being changed by another aamio, which did not finish in ${wait} seconds. Nothing changed; try again.`);
    await sleep(50);
  }
  try {
    return await act();
  } finally {
    await holder.release();
  }
}

/** Writes the list, under the lock the caller holds: a file of this process's own first, then one rename. */
async function writeEnabled(home, names) {
  const path = enabledFile(home);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ enabled: names }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new AddonError(`${path} could not be written: ${error.code || error.message}. Nothing changed; check the disk and the home's permissions, and try again.`);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      // Windows: a reader holds the file for a moment.
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 19) {
        await unlink(temporary).catch(() => {});
        throw new AddonError(`${path} could not be replaced: ${error.code || error.message}. Nothing changed; try again.`);
      }
      await sleep(50);
    }
  }
}

// ------------------------------------------------------------------- loaded

/**
 * The add-ons that run in this home: the installed ones the list names, each
 * read from its manifest and checked, with nothing of them run. Two add-ons
 * with one short name, or a tool whose name is taken already, stop here and
 * say so, rather than let the order they were found in decide which one runs:
 * a broken install is not a quiet absence.
 */
export async function loaded(home, { coreTools = [], names = null, rows = null } = {}) {
  const wanted = names ?? (await enabledNames(home));
  const found = [];
  for (const row of rows ?? (await installed(home))) {
    if (!isEnabled(row, wanted)) continue;
    const manifest = await readManifest(row);
    const other = found.find((held) => held.NAME === manifest.NAME);
    if (other) throw new AddonError(`two add-ons are called ${manifest.NAME}: ${other.distribution} and ${manifest.distribution}. Disable or uninstall one, or the order they were found in would decide which one runs.`);
    found.push(manifest);
  }
  // The tools too, here and not first when a server lists them: `aamio addon
  // list` and `aamio serve` have to agree on whether this installation works.
  toolsOf(coreTools, found);
  return found;
}

/** Every tool the add-ons bring, refused when a name is taken already. */
export function toolsOf(coreTools, manifests) {
  const taken = new Map(coreTools.map((tool) => [typeof tool === "string" ? tool : tool.name, "the core"]));
  const found = [];
  for (const manifest of manifests) {
    for (const tool of manifest.tools) {
      if (taken.has(tool.name)) {
        throw new AddonError(`the tool ${tool.name} is offered by ${taken.get(tool.name)} and by ${manifest.distribution}. Disable or uninstall one, or the order they were found in would decide which one runs.`);
      }
      taken.set(tool.name, manifest.distribution);
      found.push(tool);
    }
  }
  return found;
}

/**
 * What aamio addon list answers: every add-on installed in this home, whether
 * it runs here, and for one that runs its commands and tools. Nothing is run
 * and nothing is written: a home that is not there is as it was afterwards.
 * When an enabled add-on cannot be loaded the list still answers, with the
 * error and the command that takes the add-on out.
 */
export async function describe(home, { coreTools = [] } = {}) {
  const wanted = await enabledNames(home);
  let rows = [];
  let running = [];
  let error = null;
  try {
    rows = await installed(home);
    running = await loaded(home, { coreTools, names: wanted, rows });
  } catch (failure) {
    if (!(failure instanceof AddonError)) throw failure;
    error = failure.message;
  }
  const manifests = new Map();
  const said = [];
  for (const row of rows) {
    const entry = { name: null, version: row.version, distribution: row.distribution, enabled: isEnabled(row, wanted) };
    try {
      // Which contract, its short name, and which variables it asks for by
      // name: said before the add-on is enabled, from the manifest alone.
      const manifest = await readManifest(row);
      manifests.set(row.distribution, manifest);
      entry.name = manifest.NAME;
      entry.contract = 2;
      if (manifest.environment.length) entry.environment = [...manifest.environment];
    } catch (failure) {
      if (!(failure instanceof AddonError)) throw failure;
      entry.error = failure.message;
    }
    said.push(entry);
  }
  for (const entry of said) {
    const manifest = manifests.get(entry.distribution);
    if (entry.enabled) {
      const runs = running.find((held) => held.distribution === entry.distribution);
      if (runs) Object.assign(entry, { version: runs.version, commands: runs.commandNames(), mcp_tools: runs.tools.map((tool) => tool.name) });
      else entry.loaded = false;
    } else {
      // By its short name when no other installed add-on has it, by its package otherwise.
      const same = manifest ? said.filter((other) => other !== entry && other.name === manifest.NAME) : [];
      entry.fix = `aamio addon enable ${manifest && !same.length ? manifest.NAME : entry.distribution}`;
    }
  }
  const answer = { addons: said };
  const missing = notInstalled(wanted, rows);
  if (missing.length) answer.enabled_but_not_installed = missing;
  if (error !== null) answer.error = error;
  if (!said.length && error === null && !missing.length) {
    answer.note = `No add-on is installed in this home. An add-on is a package of its own, installed with npm in the home's folder for add-ons, once aamio init has given the home its identity, and then enabled by name: ${installWords(home)} and aamio addon enable domain for Domain Keys.`;
  }
  return answer;
}

/** The packages this runtime recorded as enabled and does not find among the installed ones. */
function notInstalled(names, rows) {
  return names.filter((name) => name.toLowerCase().startsWith(PREFIX) && !rows.some((row) => sameEntry(name, row.distribution))).map((name) => name.slice(PREFIX.length));
}

/**
 * The add-ons enabled in this home that are not installed there any more: an
 * uninstall, or a folder that was moved. They do not run, and that is said
 * where the user would otherwise only see a tool that is not there.
 */
export async function enabledButMissing(home) {
  return notInstalled(await enabledNames(home), await installed(home));
}

/** The installed add-on `which` names, by short name or by package: its package, refused when none or two fit. */
async function pick(home, which) {
  const hits = new Set();
  const unread = [];
  for (const row of await installed(home)) {
    if (row.distribution.toLowerCase() === String(which).toLowerCase()) {
      hits.add(row.distribution);
      continue;
    }
    try {
      if ((await readManifest(row)).NAME === which) hits.add(row.distribution);
    } catch (failure) {
      // One that cannot be read has no short name to be picked by.
      if (!(failure instanceof AddonError)) throw failure;
      unread.push(row.distribution);
    }
  }
  const packages = [...hits].sort();
  if (!packages.length) {
    // The one that was meant may be among those that could not be read: said, with where the reason is.
    const broken = unread.length ? ` ${unread.join(" and ")} ${unread.length === 1 ? "is" : "are"} installed and cannot be read as an add-on, so ${unread.length === 1 ? "it has" : "they have"} no short name: aamio addon list says why, and aamio addon enable with the package's name says it too.` : "";
    throw new AddonError(`no installed add-on is called ${which}.${broken} aamio addon list says which are installed in this home; an add-on is installed first, as ${installWords(home)} for Domain Keys.`);
  }
  if (packages.length > 1) throw new AddonError(`two installed add-ons are called ${which}: ${packages.join(" and ")}. Enable one by its package name.`);
  return packages[0];
}

/**
 * What enable says of an add-on: the same words as aamio-python, aamio-php
 * and https://aamio.at/docs/addons. probed is whether the probe ran now; it
 * does not for an add-on that was enabled already.
 */
export function enableNote(distribution, environment, probed = true) {
  const asked = environment.length ? `, and ${environment.join(", ")}, which its manifest asks for` : "";
  const ran = probed ? "enable started it once just now, before the choice was recorded, to see that it answers as its manifest says." : "It was enabled already, and nothing of it ran now.";
  return `${distribution} runs here from now on, in a process of its own for each call. ${ran} ` +
    "A call gets its arguments, a key aamio resolved for it, the runtime's public key where a " +
    "command asks for it, a directory of its own under the home, and a short list of environment variables: the path, a temporary directory, " +
    `the locale, the interpreter's own settings, TLS roots and the proxy variables, which can carry credentials of their own${asked}, and never the ` +
    "home's key or the rest of your environment. Nothing it answers changes state in aamio. It runs with your own file permissions.";
}

/**
 * Lets an installed add-on run here, once it has been read clean and has
 * answered the probe: a broken one is refused, not recorded. probe(manifest)
 * starts the add-on's process once, before anything is written.
 */
export async function enable(home, which, { probe, coreTools = [], lock } = {}) {
  const distribution = await pick(home, which);
  let probed = false;
  await withListLock(home, async () => {
    const names = await enabledNames(home);
    if (names.some((name) => sameEntry(name, distribution))) return;
    const manifests = await loaded(home, { coreTools, names: [...names, entryOf(distribution)] });
    // Before anything is recorded: the process starts, speaks the protocol
    // and is the add-on the manifest says.
    await probe(manifests.find((manifest) => manifest.distribution === distribution));
    probed = true;
    await writeEnabled(home, [...names, entryOf(distribution)]);
  }, lock);
  const answer = await describe(home, { coreTools });
  const row = answer.addons.find((entry) => entry.distribution === distribution) ?? {};
  answer.note = `${enableNote(distribution, row.environment ?? [], probed)} ${RESTART}`;
  return answer;
}

/** Takes an add-on out of the enabled list, by short name or by package, reading no more of it than its name and running nothing. */
export async function disable(home, which, { coreTools = [], lock } = {}) {
  const packages = new Set([String(which).toLowerCase()]);
  // What cannot be read has no short name to go by, and is taken out by its package.
  for (const row of await installed(home).catch((failure) => (failure instanceof AddonError ? [] : Promise.reject(failure)))) {
    try {
      if ((await readManifest(row)).NAME === which) packages.add(row.distribution.toLowerCase());
    } catch (failure) {
      if (!(failure instanceof AddonError)) throw failure;
    }
  }
  const mine = (name) => name.toLowerCase().startsWith(PREFIX) && packages.has(name.slice(PREFIX.length).toLowerCase());
  let changed = false;
  // A home that is not there has no list, and none is made to say so.
  if ((await enabledNames(home)).some(mine)) {
    await withListLock(home, async () => {
      const names = await enabledNames(home);
      const kept = names.filter((name) => !mine(name));
      if (kept.length !== names.length) {
        await writeEnabled(home, kept);
        changed = true;
      }
    }, lock);
  }
  const answer = await describe(home, { coreTools });
  answer.note = changed ? `${which} is disabled. ${RESTART}` : `${which} was not enabled; nothing on disk changed.`;
  return answer;
}

// -------------------------------------------------------------------- hosts

/**
 * The exact host a list is read from, in lowercase, or Refused. Plain ASCII
 * names of two labels or more. No port, path, IP literal, trailing dot,
 * underscore or space is trimmed into shape: anything but a host name is
 * refused. www.example.org and example.org are different places.
 */
export function normaliseHost(value) {
  const refused = new Refused("invalid_host", "A website is a plain host name of two labels or more, as example.org, with no https://, port or path. www.example.org and example.org are different places. Internationalised names are not read yet.");
  if (typeof value !== "string" || !/^[\x00-\x7f]*$/.test(value)) throw refused;
  const host = value.toLowerCase();
  const labels = host.split(".");
  if (host.length < 1 || host.length > 253 || labels.length < 2) throw refused;
  if (labels.some((label) => !LABEL.test(label) || label.startsWith("xn--"))) throw refused;
  if (/^[0-9]+$/.test(labels[labels.length - 1])) throw refused;
  if (isIP(host) !== 0) throw refused;
  return host;
}

export function isSameHost(typed, host) {
  try {
    return normaliseHost(typed) === host;
  } catch {
    return false;
  }
}

export function hostsFile(home, manifest) {
  return join(home, "addons", manifest.NAME + HOSTS_SUFFIX);
}

const unreadable = (path, manifest) => new Refused("hosts_unreadable", `${path} could not be read as a list of websites, so no website is read. Repair the file, or move it away and add the websites again with aamio addon ${manifest.NAME} allow.`);

async function readHosts(path, manifest) {
  let rows;
  try {
    // A file of the home: read past a byte order mark at its start, as the
    // other two runtimes read it. Bytes that are not UTF-8 are no list.
    rows = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw unreadable(path, manifest);
  }
  if (!Array.isArray(rows)) throw unreadable(path, manifest);
  for (const row of rows) {
    try {
      if (normaliseHost(row) !== row) throw unreadable(path, manifest);
    } catch {
      throw unreadable(path, manifest);
    }
  }
  return rows;
}

async function writeHosts(runtime, manifest, rows) {
  try {
    await mkdir(join(runtime.home, "addons"), { recursive: true, mode: 0o700 });
    await runtime.saveJson(join("addons", manifest.NAME + HOSTS_SUFFIX), rows);
  } catch {
    throw new Refused("hosts_unwritable", `${hostsFile(runtime.home, manifest)} could not be written, so the list is as it was. Check the disk and the home's permissions.`);
  }
}

/**
 * The websites the user has agreed to for this add-on, from the file as it is
 * now. A file that cannot be read is Refused, never an empty list. When the
 * list does not exist yet and the manifest names a file an earlier version
 * kept in the home, that file is read once and becomes the list, so the user
 * who allowed websites before finds them again.
 */
export async function allowedHosts(runtime, manifest) {
  const rows = await readHosts(hostsFile(runtime.home, manifest), manifest);
  if (rows !== null) return rows;
  const legacy = manifest.hosts?.legacy_file;
  if (legacy) {
    const old = await readHosts(join(runtime.home, legacy), manifest);
    if (old !== null && old.length) {
      await writeHosts(runtime, manifest, old);
      return old;
    }
  }
  return [];
}

export async function allowHost(runtime, manifest, value) {
  const host = normaliseHost(value);
  const rows = await allowedHosts(runtime, manifest);
  const added = !rows.includes(host);
  if (added) await writeHosts(runtime, manifest, [...rows, host]);
  return { host, added, hosts: added ? [...rows, host] : rows };
}

export async function forgetHost(runtime, manifest, value) {
  const host = normaliseHost(value);
  const rows = await allowedHosts(runtime, manifest);
  const removed = rows.includes(host);
  const kept = rows.filter((row) => row !== host);
  if (removed) await writeHosts(runtime, manifest, kept);
  return { host, removed, hosts: kept };
}

export function notAllowed(manifest, host) {
  const tool = manifest.toolsSpec.find((spec) => spec.host)?.name;
  const over = tool ? ` Over MCP ${tool} asks them.` : "";
  return new Refused("host_not_allowed", `This runtime reads only websites the user has put on its list, and this one is not there. The user adds it with aamio addon ${manifest.NAME} allow ${host}, from their own records and never from the message being checked.${over}`);
}

// ------------------------------------------------------------------ subject

/** The key to check and where it came from, resolved by the core: a partner in the address book, or the signer of a message this process verified. */
export function subjectFor(runtime, source, value) {
  if (source === "partner") {
    if (typeof value !== "string" || !value) throw new Refused("invalid_partner", "partner is a name in the address book.");
    let row;
    try {
      row = runtime.partnerByName(value);
    } catch (error) {
      throw new Refused("partner_unavailable", `${error.message}`);
    }
    if (!row || typeof row.key !== "string" || !KEY.test(row.key)) {
      throw new Refused("partner_unavailable", "No partner by that name with a usable key is in the address book. aamio_partners or aamio partner list shows who is.");
    }
    return { key: row.key, subject_source: "partner", partner: row.name, signature_checked_locally: null };
  }
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new Refused("invalid_message_hash", "message is the sha256 of a message as read shows it: 64 lowercase hexadecimal characters.");
  }
  const keys = runtime.verifiedSigners(value);
  if (keys.some((key) => typeof key !== "string" || !KEY.test(key))) {
    throw new Refused("invalid_local_observation", "The message is recorded here without a usable signing key, so it cannot be checked.");
  }
  if (!keys.length) {
    throw new Refused("source_unavailable", "This process holds no verified message with that hash. Only a message this process read itself and whose signature checked out can be used: an unsigned one has no key to check, and what an earlier process read is not kept and cannot be read again. Check a later message from the same sender, or the partner by name.");
  }
  if (keys.length !== 1) throw new Refused("ambiguous_signer", "Different keys signed the same bytes, so the hash does not say which one to check. Check the partner by name.");
  return { key: keys[0], subject_source: "message", message_sha256: value, signature_checked_locally: true };
}

export function subjectFields(subject) {
  if (!subject) return {};
  const { key, ...rest } = subject;
  return rest;
}

/** A directory of the add-on's own under the home, made on first use, private to the user. */
export async function stateDir(home, manifest) {
  const path = join(home, "addons", manifest.NAME);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}
