// Transports for one home, for Node (contract 3, B): the profiles, the bindings to partners, and the service the owner
// of the home runs.
//
// The home keeps, under transports/: profiles.json, the security profiles of B5; bindings.json, for each partner's key
// an ordered list of a transport and a profile; and carry.json, the carrier state of aamio-carry-v1-tilstand. The same
// files as aamio-python's transports.py and aamio-php's Transports write, so a home moves between the runtimes. A
// partner without a binding goes over HTTPS as before; a partner with one goes over its transport only, and never over
// HTTPS instead.
//
// Two files beside them are hints, and never stop a send: here.json, where each transport said it is reached, for cards
// that say it; and addresses.json, where each bound partner is reached on each transport, as the user gave it to bind or
// as a fresh envelope from the partner showed it. They are files of their own because a released core, as 0.8.0 here and
// 0.7.0 of aamio-python, refuses a binding with a field it does not know, and the same home is read by all three
// runtimes, of any version.
//
// Only the process that owns the home runs a transport (B2): aamio serve for as long as it serves, and a send or a
// read that waits, on the command line, for as long as it runs. The service starts every transport that is enabled and
// bound to a partner, in a working folder of its own outside the home, pumps the carriers in one loop of its own,
// starts a transport again after a stop after 1, 5 and 30 seconds, leaves it down after three stops in ten minutes,
// stops one that no partner is bound to any more, and stops them all with the owner. One loop pumps, so a send or a
// read waits for what it needs to see and never pumps itself.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isKey } from "./aamio.js";
import { CarryRefused, MAGIC, MAX_CONTENT, SEALED } from "./carry.js";
import { NO_CURRENT_DIRECTORY } from "./node-addon-process.js";
import { AddonError, CORE_VERSION, TransportManifest, loaded } from "./node-addons.js";
import { Carrier } from "./node-carrier.js";
import { CHALLENGE_WINDOW_DEFAULT, CarryState, LIFETIME_DEFAULT, profile as carryProfile } from "./node-carry-state.js";
import { TransportFailed, TransportProcess, environment, hereOf } from "./node-transport-host.js";

export const PROFILE_VERSION = 1;
export const DEFAULT_PROFILE = "sealed";
export const CRASH_WINDOW = 600;
export const CRASHES_MOST = 3;
// How long a start of a moment waits for a transport's first ready, to learn where it is reached (B2).
export const LEARN_SECONDS = 10;
// How much of what a transport said of its medium, as status down, transport here passes on: its own words, kept short.
export const DOWN_SAID_MOST = 300;
// Where a partner's address on a transport came from: given to bind, or heard in a fresh envelope from the partner.
export const ADDRESS_FROM = ["you", "heard"];
// What a carried message is filed under when the partner it came from is no longer bound to a transport.
export const UNBOUND_CHANNEL = "carry";
// How often a running carrier's list of whom it takes messages from is read again, and what runs is held against the
// bindings: a partner removed meanwhile is taken from no longer than this after, and a transport nobody is bound to any
// more runs no longer than this after.
export const KNOWN_REFRESH = 2;
// The window a profile for a slow medium is told to give, at the least.
export const CHALLENGE_WINDOW_SLOW = 300;
// How long a transport that stopped waits before it is started again, and how long a send waits; a test may shorten them.
export const timing = { restartAfter: [1, 5, 30], waitDefault: 30 };

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const now = () => performance.now() / 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const coded = (code, message) => Object.assign(new Error(message), { code });
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64url = (text) => new Uint8Array(Buffer.from(text, "base64url"));
// A partner's key as the carrier keeps addresses under it: its bytes in hex.
const hexOf = (key) => Buffer.from(key, "base64url").toString("hex");
const unixNow = () => Math.floor(Date.now() / 1000);

/** A profile as B5 writes it: with a challenge, on a medium both ways, the clock trusted. */
export function profileRecord(name, { mode = "sealed", lifetime = LIFETIME_DEFAULT, window = CHALLENGE_WINDOW_DEFAULT, maxContent = MAX_CONTENT } = {}) {
  return { name, version: PROFILE_VERSION, mode, challenge: true, accept_unchallenged: false, lifetime, challenge_window: window, clock_trusted: true, max_content: maxContent, radio: null };
}

/** The profile the core holds to (B5), from a record in profiles.json; an error with transport_profile_* when it is not one. */
export function checked(record) {
  if (!isObject(record) || record.version !== PROFILE_VERSION) {
    throw coded("transport_profile_unknown", `the profile ${JSON.stringify(isObject(record) ? record.name ?? null : null)} is of a version this aamio does not know, so nothing is sent with it`);
  }
  if (record.radio !== null && record.radio !== undefined) throw coded("transport_profile_incomplete", `the profile ${record.name} has radio settings, and v1 has no radio transport`);
  if (typeof record.name !== "string" || !PROFILE_NAME.test(record.name)) throw coded("transport_profile_invalid", "a profile's name is 1 to 32 characters of a-z, 0-9, dash and underscore");
  if (["challenge", "accept_unchallenged", "clock_trusted"].some((field) => typeof record[field] !== "boolean")
    || ["lifetime", "challenge_window", "max_content"].some((field) => !Number.isInteger(record[field]))) {
    throw coded("transport_profile_invalid", `the profile ${record.name} has a field of the wrong kind`);
  }
  try {
    return carryProfile({ mode: record.mode, challenge: record.challenge, acceptUnchallenged: record.accept_unchallenged, lifetime: record.lifetime,
      challengeWindow: record.challenge_window, clockTrusted: record.clock_trusted, maxContent: record.max_content });
  } catch (error) {
    throw coded("transport_profile_invalid", `the profile ${record.name} cannot be used: ${error.message}`);
  }
}

/** B2: the transport's folder, outside the home and private to the user, one per home and transport. */
export function workingFolder(home, name, { make = true } = {}) {
  const h = createHash("sha256").update(path.resolve(home), "utf8").digest("hex").slice(0, 8);
  let base;
  if (process.platform === "win32") base = path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "aamio-transports");
  else if (process.platform === "darwin") base = path.join(homedir(), "Library", "Application Support", "aamio-transports");
  else base = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "aamio-transports");
  const folder = path.join(base, `${name}-${h}`);
  if (make) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

/** B2: contract 2's short list, AAMIO_ADDON=3 and, unless declared is false, what the manifest declares, made safe as contract 2 makes it. */
export function environmentFor(manifest, { base = process.env, declared = true } = {}) {
  const env = environment(declared ? manifest.environment : [], base);
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) if (key.toUpperCase() === NO_CURRENT_DIRECTORY.toUpperCase()) delete env[key];
    env[NO_CURRENT_DIRECTORY] = "1";
  }
  return env;
}

/**
 * What enable asks of a transport before anything is recorded: it starts, describes itself as its manifest says, and
 * stops. hello says probe, and a transport then takes nothing of its medium in use (B3). It runs with the short list and
 * none of the variables its manifest asks for, as contract 2's probe does.
 */
export async function probe(manifest, home) {
  const folder = workingFolder(home, manifest.NAME);
  const heard = [];
  const process_ = new TransportProcess(manifest.NAME, manifest.version, [process.execPath, manifest.entry], folder, environmentFor(manifest, { declared: false }), { log: (line) => heard.push(line) });
  try {
    await process_.start(CORE_VERSION, "node", folder, { probe: true });
  } catch (error) {
    if (!(error instanceof TransportFailed)) throw error;
    await sleep(200);
    const said = heard.length ? ` It said: ${heard[heard.length - 1]}` : "";
    throw new AddonError(`the transport ${manifest.NAME} did not start and describe itself as its manifest says: ${error.message}.${said} Nothing was recorded; reinstall it, or ${manifest.fix} to go on without it.`);
  } finally {
    await process_.stop();
  }
  if (process_.medium !== manifest.medium) {
    throw new AddonError(`the transport ${manifest.NAME} describes itself as one over ${JSON.stringify(process_.medium)}, and its manifest says ${manifest.medium}. Nothing was recorded; reinstall it, or ${manifest.fix} to go on without it.`);
  }
}

/** What read shows of carried content: the body over HTTPS has the same fields, text or data, re and seen, and the same reading of what is not JSON or not UTF-8. */
export function bodyOf(content, sealed, bodyJson) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch (error) {
    return [{ text: null }, { signed: true, encrypted: sealed, format: "unreadable", error: error.name || "Error" }];
  }
  const read = bodyJson(text);
  if (read === null) return [{ text }, { signed: true, encrypted: sealed, format: "text" }];
  return isObject(read.value) ? [read.value, { signed: true, encrypted: sealed, format: "json" }] : [{ text }, { signed: true, encrypted: sealed, format: "json" }];
}

/** profiles.json and bindings.json under transports/ in the home, read whole and written atomically. */
export class Config {
  constructor(home) {
    this.home = home;
    this.dir = path.join(home, "transports");
  }

  #read(name, field) {
    const file = path.join(this.dir, name);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      text = null;
    }
    let value = null;
    try {
      value = text === null ? null : JSON.parse(text);
    } catch {
      value = null;
    }
    if (!isObject(value) || value.version !== 1 || !isObject(value[field])) {
      throw coded("transport_config_unreadable", `${file} could not be read. Which partners go over a transport is not known while it cannot, so nothing is sent to a partner until it is repaired or moved away`);
    }
    return value[field];
  }

  #write(name, field, value) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, name);
    const tmp = `${file}.tmp`;
    try {
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ version: 1, [field]: value }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (error) {
      throw coded("not_saved", `${file} could not be written (${error.code || error.message}), so it is as it was. Free the disk, or give this user write access to ${this.dir}, and do it again.`);
    }
  }

  profiles() {
    return this.#read("profiles.json", "profiles");
  }

  bindings() {
    const found = this.#read("bindings.json", "partners");
    for (const routes of Object.values(found)) {
      if (!Array.isArray(routes) || !routes.length || routes.some((route) => !isObject(route) || Object.keys(route).sort().join(",") !== "profile,transport"
        || typeof route.transport !== "string" || typeof route.profile !== "string")) {
        throw coded("transport_config_unreadable", `${path.join(this.dir, "bindings.json")} has a binding that is not a list of transport and profile. Nothing is sent to a partner until it is repaired or moved away`);
      }
    }
    return found;
  }

  profile(name) {
    const found = this.profiles()[name];
    if (found === undefined && name === DEFAULT_PROFILE) return profileRecord(DEFAULT_PROFILE);
    if (found === undefined) throw coded("transport_profile_unknown", `no profile called ${name}: aamio transport profile add ${name}`);
    return found;
  }

  #inUse(name) {
    return Object.values(this.bindings()).some((routes) => routes.some((route) => route.profile === name));
  }

  addProfile(record) {
    checked(record);
    const profiles = this.profiles();
    if (Object.hasOwn(profiles, record.name) && this.#inUse(record.name) && JSON.stringify(profiles[record.name]) !== JSON.stringify(record)) {
      // A change under a bound partner changes how its messages are checked while they are under way.
      throw coded("transport_profile_in_use", `the profile ${record.name} is bound to a partner: aamio transport unbind first, or add a profile of another name`);
    }
    profiles[record.name] = record;
    this.#write("profiles.json", "profiles", profiles);
  }

  removeProfile(name) {
    if (this.#inUse(name)) throw coded("transport_profile_in_use", `the profile ${name} is bound to a partner: aamio transport unbind first`);
    const profiles = this.profiles();
    if (!Object.hasOwn(profiles, name)) throw coded("transport_profile_unknown", `no profile called ${name}`);
    delete profiles[name];
    this.#write("profiles.json", "profiles", profiles);
  }

  bind(key, transport, profileName) {
    const record = this.profile(profileName);
    checked(record);
    if (!Object.hasOwn(this.profiles(), profileName)) this.addProfile(record);
    const bindings = this.bindings();
    const routes = bindings[key] ?? [];
    if (routes.some((route) => route.transport === transport)) throw coded("transport_already_bound", `${transport} is bound to that partner already`);
    routes.push({ transport, profile: profileName });
    bindings[key] = routes;
    this.#write("bindings.json", "partners", bindings);
    return routes;
  }

  /** The partner's bindings without transport, or none at all: what is left. */
  unbind(key, transport = null) {
    const bindings = this.bindings();
    if (!Object.hasOwn(bindings, key) || (transport !== null && !bindings[key].some((route) => route.transport === transport))) {
      throw coded("transport_unbound", `that partner is not bound to ${transport ?? "a transport"}`);
    }
    const routes = transport === null ? [] : bindings[key].filter((route) => route.transport !== transport);
    if (routes.length) bindings[key] = routes;
    else delete bindings[key];
    this.#write("bindings.json", "partners", bindings);
    try {
      this.dropAddresses(key, transport);
    } catch (error) {
      // A hint left for a partner no longer bound is never used: addresses are looked up by binding.
      if (typeof error?.code !== "string") throw error;
    }
    return routes;
  }

  routes(key) {
    return this.bindings()[key] ?? [];
  }

  // ------------------------------------------------------------ hints

  /** A hint file's field, or {} when it is not there or cannot be read: where something is reached never stops a send. */
  #readHint(name, field) {
    try {
      return this.#read(name, field);
    } catch (error) {
      if (error?.code !== "transport_config_unreadable") throw error;
      return {};
    }
  }

  /**
   * transport name -> { medium, here, at, version }: where each transport said it is reached, the last time it said, and
   * the version that said it. An empty here is a transport that said nothing of it: kept, so one whose medium has no
   * addresses, as sound, is not started again for every card. version is null in a file without it.
   */
  here() {
    const found = {};
    for (const [name, entry] of Object.entries(this.#readHint("here.json", "transports"))) {
      if (name === "__proto__" || !isObject(entry) || typeof entry.medium !== "string" || !Number.isInteger(entry.at) || hereOf(entry.here, entry.medium) === null) continue;
      found[name] = { medium: entry.medium, here: [...entry.here], at: entry.at, version: typeof entry.version === "string" ? entry.version : null };
    }
    return found;
  }

  setHere(name, medium, here, at, version = null) {
    const known = this.#readHint("here.json", "transports");
    known[name] = { medium, here: [...here], at: Math.floor(at) };
    if (version !== null && version !== undefined) known[name].version = version;
    this.#write("here.json", "transports", known);
  }

  /** partner key -> transport -> { address, from, at }: where each bound partner is reached on each transport. */
  addresses() {
    const found = {};
    for (const [key, by] of Object.entries(this.#readHint("addresses.json", "partners"))) {
      if (key === "__proto__" || !isObject(by)) continue;
      for (const [transport, entry] of Object.entries(by)) {
        if (transport === "__proto__" || !isObject(entry) || typeof entry.address !== "string" || !ADDRESS_FROM.includes(entry.from) || !Number.isInteger(entry.at)
          || hereOf([entry.address], entry.address.split(":", 1)[0]) === null) continue;
        if (!Object.hasOwn(found, key)) found[key] = {};
        found[key][transport] = { address: entry.address, from: entry.from, at: entry.at };
      }
    }
    return found;
  }

  setAddress(key, transport, address, source, at) {
    const known = this.#readHint("addresses.json", "partners");
    const by = Object.hasOwn(known, key) && isObject(known[key]) ? known[key] : {};
    by[transport] = { address, from: source, at: Math.floor(at) };
    known[key] = by;
    this.#write("addresses.json", "partners", known);
  }

  dropAddresses(key, transport = null) {
    const known = this.#readHint("addresses.json", "partners");
    const by = Object.hasOwn(known, key) ? known[key] : null;
    if (!isObject(by)) return;
    if (transport === null) {
      delete known[key];
    } else {
      if (!Object.hasOwn(by, transport)) return;
      delete by[transport];
      if (!Object.keys(by).length) delete known[key];
    }
    this.#write("addresses.json", "partners", known);
  }

  statePath() {
    return path.join(this.dir, "carry.json");
  }
}

/** The transports this owner runs, with one carrier each, and what goes in and out through them. */
export class Service {
  constructor(runtime) {
    this.runtime = runtime;
    this.config = new Config(runtime.home);
    this.state = null;
    this.running = new Map();   // transport name -> { manifest, process, carrier, crashes, next, down }
    this.loop = null;
    // True from the moment stop begins, and for good: nothing is added or started after it, also by a start that
    // began before it. The service stops once, with its owner.
    this.stopping = false;
    // Starts under way, which stop waits for before it says that nothing of this service runs.
    this.starts = new Set();
    // A start of a moment under way, by transport name: the promise of its answer. One at a time per transport, never
    // beside its ordinary start, and none after the stop (a review of 20 November 2026).
    this.learning = new Map();
    // What a transport said of its medium the last time a start of a moment did not come up, by name: the reason
    // transport here gives. A transport says it as status down on the protocol, not on standard error, and here said only
    // that "the lines it wrote above" said why, with none written (a check of 22 November 2026).
    this.downSaid = new Map();
    // The environment a transport's variables are read from: process.env, unless a test or an embedder says otherwise.
    this.environ = null;
    this.knownAt = 0;
  }

  // ------------------------------------------------------------ what is there

  async manifests() {
    const found = new Map();
    for (const manifest of await loaded(this.runtime.home)) if (manifest instanceof TransportManifest) found.set(manifest.NAME, manifest);
    return found;
  }

  carry() {
    this.state ??= new CarryState(this.runtime.keys, this.config.statePath());
    return this.state;
  }

  /** Whether some partner in the address book is bound to a transport; transport_config_unreadable when that cannot be known. */
  bound() {
    return Object.keys(this.config.bindings()).some((key) => this.runtime.partnerByKey(key) !== null);
  }

  /** Whether something came over a transport and waits for a read, whatever is bound now: an unbind leaves it to be read. */
  hasPending() {
    if (!fs.existsSync(this.config.statePath())) return false;
    return this.carry().pending().length > 0;
  }

  /** Every transport a partner in the address book is bound to, in the order first named. */
  wanted() {
    const names = [];
    for (const [key, routes] of Object.entries(this.config.bindings())) {
      if (this.runtime.partnerByKey(key) === null) continue;
      for (const route of routes) if (!names.includes(route.transport)) names.push(route.transport);
    }
    return names;
  }

  /** The keys a transport takes messages from: partners in the address book bound to it, and no one who has left the book. */
  knownFor(transport) {
    return Object.entries(this.config.bindings())
      .filter(([key, routes]) => this.runtime.partnerByKey(key) !== null && routes.some((route) => route.transport === transport))
      .map(([key]) => unb64url(key));
  }

  routeOf(pk) {
    return this.config.routes(b64url(pk))[0] ?? null;
  }

  profileFor(pk) {
    const route = this.routeOf(pk);
    return checked(this.config.profile(route ? route.profile : DEFAULT_PROFILE));
  }

  // ------------------------------------------------------------ running

  /**
   * Every transport that is bound and enabled, started, and pumped in a loop of the service's own. Nothing once stop
   * has begun: a runtime that is closed does not start its transports again.
   */
  async start() {
    if (this.stopping) return this;
    const under = this.#start();
    this.starts.add(under);
    try {
      await under;
    } finally {
      this.starts.delete(under);
    }
    return this;
  }

  async #start() {
    await this.#add(this.wanted());
    await this.#startDue();
    if (!this.stopping && !this.loop && this.running.size) this.loop = this.#run();
  }

  /** Transports to run, each once, with the manifests read only when one is new. */
  async #add(names) {
    if (names.every((name) => this.running.has(name))) return;
    const manifests = await this.manifests();
    // Stopped while the manifests were read: nothing is added after that. Added then, the transport was started and
    // the loop with it after the owner had let go of the home (the check of 16 November 2026).
    if (this.stopping) return;
    for (const name of names) {
      // Looked at again now that the manifests are read: a send and the service's own loop may both be adding.
      if (this.running.has(name)) continue;
      const entry = { manifest: manifests.get(name) ?? null, process: null, carrier: null, crashes: [], next: 0, down: null, starting: false };
      if (!entry.manifest) {
        entry.down = `${name} is bound to a partner and is not an enabled transport here: aamio addon enable ${name}`;
        this.runtime.log?.(`transport ${name}: ${entry.down}`);
      }
      this.running.set(name, entry);
    }
  }

  /**
   * What a carrier has to tell the user, as a message that is not sent again: in attention under the transport's name,
   * where a read shows it, and in the log, where a command that sends and ends shows it.
   */
  /**
   * Say it when a partner's profile gives a challenge less time than this medium needs for it and its open.
   *
   * Over sound a challenge and its open take close to a minute in the air alone, and two with the waits for a turn, and the
   * profile sealed gives 60 seconds: most opens would come too late and be turned down, few sessions would open, and sends
   * would end in carry_not_sent or without a receipt, with nothing to say why. Not private, so a test can give it a
   * carrier over a slow medium.
   */
  checkWindows(name, carrier) {
    const need = carrier.handshakeSeconds();
    if (need <= 0) return;
    let bindings;
    try {
      bindings = this.config.bindings();
    } catch {
      return;
    }
    for (const [key, routes] of Object.entries(bindings)) {
      const route = routes.find((candidate) => candidate.transport === name);
      const partner = this.runtime.partnerByKey(key);
      if (!route || partner === null || partner === undefined) continue;
      let window;
      try {
        window = checked(this.config.profile(route.profile)).challengeWindow;
      } catch {
        continue;
      }
      if (window >= need) continue;
      // Long enough for an open to have three tries, in whole minutes, as long as a profile can give at the most.
      const longer = Math.min(Math.max(CHALLENGE_WINDOW_SLOW, Math.ceil(carrier.windowForOpens() / 60) * 60), 600);
      const text = `the profile ${route.profile} gives a challenge ${window} seconds to be answered, and on ${name} a challenge and its open take up `
        + `to ${Math.floor(carrier.airtimeOfHandshake())} seconds in the air, more with the waits for a turn: most sessions with ${partner.name} cannot `
        + `open, and a send to ${partner.name} ends in carry_not_sent or gets no receipt. A window of ${longer} seconds gives an open three tries: `
        + `aamio transport profile add ${route.profile}-slow --window ${longer} --lifetime 3600, then aamio transport unbind ${partner.name} and `
        + `aamio transport bind ${partner.name} ${name} --profile ${route.profile}-slow`;
      this.runtime.log?.(`transport ${name}: ${text}`);
      if (typeof this.runtime.note === "function") this.runtime.note(name, "window_too_short", text);
    }
  }

  #say(name, text) {
    this.runtime.log?.(`transport ${name}: ${text}`);
    if (typeof this.runtime.note === "function") this.runtime.note(name, "not_sent_again", text);
  }

  /**
   * Who each running carrier takes messages from, read again; a transport no partner is bound to any more is stopped, so
   * it no longer holds its port and is not started again after a stop, and one bound meanwhile is started (the follow-up
   * check of 15 November 2026).
   */
  async #refresh() {
    let wanted;
    try {
      wanted = this.wanted();
    } catch (error) {
      // Whom to take messages from is not known while the bindings cannot be read: no one, then, and nothing stopped.
      for (const entry of this.running.values()) if (entry.carrier) entry.carrier.known = [];
      this.runtime.log?.(`transports: ${error.message}`);
      return;
    }
    for (const [name, entry] of [...this.running]) {
      if (wanted.includes(name)) continue;
      this.running.delete(name);
      if (entry.process) await entry.process.stop();
      this.runtime.log?.(`transport ${name}: stopped, since no partner in the address book is bound to it any more`);
    }
    await this.#add(wanted);
    const addresses = this.config.addresses();
    for (const [name, entry] of this.running) {
      if (!entry.carrier) continue;
      try {
        entry.carrier.known = this.knownFor(name);
      } catch (error) {
        entry.carrier.known = [];
        this.runtime.log?.(`transport ${name}: ${error.message}`);
      }
      // Given to bind meanwhile, or learned by another owner of this home: what the home keeps is the newest.
      for (const [partner, address] of this.#addressesFor(name, addresses)) entry.carrier.addresses.set(partner, address);
    }
  }

  // ------------------------------------------------------------ where things are reached

  /**
   * partner pk in hex -> where it is reached on the transport, as the home keeps it, for the partners bound to it: a hint
   * left behind for one no longer bound, or no longer in the address book, is never used.
   */
  #addressesFor(name, addresses = null) {
    const bound = new Set(this.knownFor(name).map((pk) => b64url(pk)));
    const found = new Map();
    for (const [key, by] of Object.entries(addresses ?? this.config.addresses())) {
      if (Object.hasOwn(by, name) && bound.has(key)) found.set(hexOf(key), by[name].address);
    }
    return found;
  }

  /** A fresh envelope from the partner came from address: kept, so the next owner of the home asks there first. */
  #heard(name, pk, address) {
    try {
      this.config.setAddress(b64url(pk), name, address, "heard", unixNow());
    } catch (error) {
      if (typeof error?.code !== "string") throw error;
      this.runtime.log?.(`transport ${name}: where a partner was heard from could not be kept: ${error.message}`);
    }
  }

  /**
   * The transport said where it is reached, or said nothing of it (an empty list): kept for cards, as an add-on that
   * needs here gets it, with the version that said it.
   */
  #here(name, medium, here, version = null) {
    try {
      this.config.setHere(name, medium, here, unixNow(), version);
    } catch (error) {
      if (typeof error?.code !== "string") throw error;
      this.runtime.log?.(`transport ${name}: where it is reached could not be kept: ${error.message}`);
    }
  }

  #nameOf(pk) {
    const partner = this.runtime.partnerByKey(b64url(pk));
    return partner ? partner.name : `the key ${b64url(pk).slice(0, 8)}`;
  }

  /**
   * Where an enabled transport is reached: [addresses or null, how it is known].
   *
   * The running one says it on its ready. One that does not run is started for a moment, as B2 allows for this alone, and
   * stopped at its first ready: the ready says where it is reached, or that it says nothing of it. The start is a hello
   * like any other, not a probe, since a probe takes nothing of the medium in use and so would say nothing.
   */
  async learnHere(name, seconds = LEARN_SECONDS) {
    const manifest = (await this.manifests()).get(name);
    if (!manifest) {
      throw coded("transport_unknown", `no enabled transport is called ${name}. aamio addon list shows what is installed, and aamio addon enable ${name} lets it run here`);
    }
    // From here to the reservation below nothing is awaited, so no other start comes in between.
    if (this.stopping) {
      // Its owner has let go of the home: nothing starts any more, not even for a moment. Two lookups that overlapped a
      // close started a transport after the next owner held the home (a review of 20 November 2026).
      return [null, "stopping"];
    }
    const entry = this.running.get(name);
    // Never a second one beside it: the two would fight over the medium, as a port or a channel.
    if (entry?.process) return [entry.process.here, entry.process.readied ? "running" : "starting"];
    // Nor beside the ordinary start while that one starts it.
    if (entry?.starting) return [null, "starting"];
    // One start of a moment per transport: a second lookup waits for the first one's answer.
    const under = this.learning.get(name);
    if (under) return await under;
    const mine = this.#learnOnce(name, manifest, seconds);
    this.learning.set(name, mine);
    try {
      return await mine;
    } finally {
      if (this.learning.get(name) === mine) this.learning.delete(name);
    }
  }

  /** The start of a moment itself, reserved by learnHere: started, asked, stopped, and kept unless stopped meanwhile. */
  async #learnOnce(name, manifest, seconds) {
    const folder = workingFolder(this.runtime.home, name);
    const transport = new TransportProcess(name, manifest.version, [process.execPath, manifest.entry], folder,
      environmentFor(manifest, { base: this.environ ?? process.env }), { log: (line) => this.runtime.log?.(line) });
    let said = null;
    try {
      await transport.start(CORE_VERSION, "node", folder);
      const until = now() + seconds;
      while (!transport.readied && now() < until && !this.stopping) {
        for (const [kind, state, reason] of await transport.poll(100)) {
          if (kind === "status" && state === "down" && typeof reason === "string" && reason.trim()) said = [...reason.trim()].slice(0, DOWN_SAID_MOST).join("");
        }
      }
    } catch (error) {
      if (!(error instanceof TransportFailed) && typeof error?.code !== "string") throw error;
      throw coded("transport_down", `${name} did not start to say where it is reached: ${error.message}`);
    } finally {
      await transport.stop();
    }
    // Stopped while it started: an owner that has let go of the home writes nothing into it.
    if (this.stopping) return [null, "stopping"];
    if (!transport.readied) {
      this.downSaid.set(name, said);
      return [null, "not_ready"];
    }
    this.downSaid.delete(name);
    // Said nothing is kept too, as an empty list, so a transport over a medium without addresses is not started again
    // for every card: the microphone of a transport over sound opened each time (the review of 19 November 2026).
    this.#here(name, manifest.medium, transport.here ?? [], manifest.version);
    return [transport.here, "learned"];
  }

  /**
   * What an add-on that needs here gets: each enabled transport's medium and where it is reached, as the running one says
   * it, else as the home keeps it from this version of the transport, else learned now by a start of a moment, at most
   * once per version. Never a partner's.
   *
   * A transport that says nothing of it is there with an empty list: the medium is this machine's, and it has no address
   * on it, as sound or Bluetooth LE, so a card names the medium alone and says nothing is wrong. One that could not say
   * now, as when its medium is off, is left out (the review of 19 November 2026).
   */
  async hereForAddons() {
    const manifests = await this.manifests();
    const kept = this.config.here();
    const out = [];
    for (const [name, manifest] of manifests) {
      const entry = this.running.get(name);
      const running = entry?.process && entry.process.readied ? [...(entry.process.here ?? [])] : null;
      const said = Object.hasOwn(kept, name) ? kept[name] : null;
      let here;
      let at;
      if (running !== null) {
        [here, at] = [running, unixNow()];
      } else if (said !== null && said.medium === manifest.medium && (said.version === null || said.version === manifest.version)) {
        [here, at] = [said.here, said.at];
      } else {
        let how;
        try {
          [here, how] = await this.learnHere(name);
        } catch (error) {
          if (!["transport_down", "transport_unknown"].includes(error?.code)) throw error;
          this.runtime.log?.(`transport ${name}: ${error.message}`);
          [here, how] = [null, "failed"];
        }
        // It said ready: what it said of where it is reached, or nothing, which is an empty list.
        if (how === "learned" || how === "running") here = [...(here ?? [])];
        at = unixNow();
      }
      if (here !== null && here !== undefined) out.push({ transport: name, medium: manifest.medium, here: [...here], at });
    }
    return out;
  }

  /**
   * What an add-on that needs media gets: each enabled transport's name and medium, as its manifest says them, ordered by
   * name. From the manifests alone, and nothing is started: a reader of a card asks only which media this machine has,
   * and a transport over Bluetooth LE announces this machine as it starts (19 November 2026).
   */
  async mediaForAddons() {
    const manifests = await this.manifests();
    return [...manifests.keys()].sort().map((name) => ({ transport: name, medium: manifests.get(name).medium }));
  }

  async #startDue() {
    const at = now();
    for (const [name, entry] of this.running) {
      if (this.stopping) return;
      if (entry.carrier || entry.starting || !entry.manifest || entry.down !== null || at < entry.next) continue;
      // Started for a moment just now, to say where it is reached: the ordinary start waits for that one to end.
      if (this.learning.has(name)) continue;
      const folder = workingFolder(this.runtime.home, name);
      const transport = new TransportProcess(name, entry.manifest.version, [process.execPath, entry.manifest.entry], folder,
        environmentFor(entry.manifest, { base: this.environ ?? process.env }), { log: (line) => this.runtime.log?.(line) });
      // One start of a transport at a time: a send or a read that starts the service while its loop starts the same
      // transport would start it twice, and the second would find the port taken.
      entry.starting = true;
      try {
        await transport.start(CORE_VERSION, "node", folder);
        if (this.running.get(name) !== entry) {
          // Taken out of what runs while it started, as when its last partner was unbound or the owner stopped.
          await transport.stop();
          continue;
        }
        const { medium, version } = entry.manifest;
        entry.carrier = new Carrier(this.carry(), transport, (pk) => this.profileFor(pk), this.knownFor(name),
          { log: (line) => this.runtime.log?.(line), note: (text) => this.#say(name, text), addresses: this.#addressesFor(name),
            heard: (pk, address) => this.#heard(name, pk, address), nameOf: (pk) => this.#nameOf(pk), onHere: (here) => this.#here(name, medium, here, version) });
        entry.process = transport;
        this.runtime.log?.(`transport ${name}: up`);
        this.checkWindows(name, entry.carrier);
      } catch (error) {
        await transport.stop();
        if (error instanceof TransportFailed) {
          if (this.running.get(name) === entry) await this.#crashed(name, entry, error);
        } else if (error instanceof CarryRefused || typeof error?.code === "string") {
          // Not the transport: the carrier state is closed after a write failed, or a profile cannot be read. It stays
          // down with the reason rather than start again every second.
          entry.down = `${error.message}. It stays down until that is put right and aamio starts again`;
          this.runtime.log?.(`transport ${name}: down: ${entry.down}`);
        } else throw error;
      } finally {
        entry.starting = false;
      }
    }
  }

  async #crashed(name, entry, error) {
    if (entry.process) await entry.process.stop();
    entry.process = null;
    entry.carrier = null;
    const at = now();
    entry.crashes = [...entry.crashes.filter((when) => at - when < CRASH_WINDOW), at];
    if (entry.crashes.length >= CRASHES_MOST) {
      entry.down = `it stopped ${CRASHES_MOST} times in ${CRASH_WINDOW / 60} minutes, last: ${error.message}. It stays down until aamio starts again`;
      this.runtime.log?.(`transport ${name}: down: ${entry.down}`);
      return;
    }
    const after = timing.restartAfter[entry.crashes.length - 1];
    entry.next = at + after;
    this.runtime.log?.(`transport ${name}: down: ${error.message}, started again in ${after} seconds`);
  }

  /** One round: what runs held against the bindings when that is due, every carrier pumped, and transports that are due started. */
  async pump(timeoutMs = 20) {
    const at = now();
    if (at - this.knownAt >= KNOWN_REFRESH) {
      this.knownAt = at;
      await this.#refresh();
    }
    for (const [name, entry] of this.running) {
      if (!entry.carrier) continue;
      try {
        await entry.carrier.pump(timeoutMs);
      } catch (error) {
        if (!(error instanceof TransportFailed)) throw error;
        await this.#crashed(name, entry, error);
      }
    }
    await this.#startDue();
  }

  async #run() {
    while (!this.stopping) {
      try {
        await this.pump(20);
      } catch (error) {
        // The state closed after a write that failed, or something else no carrier caught: said, and tried again.
        this.runtime.log?.(`transports: ${error.message}`);
        await sleep(1000);
        continue;
      }
      if (![...this.running.values()].some((entry) => entry.carrier)) await sleep(200);
    }
  }

  /** Until condition holds or until passes, on the monotonic clock: the service's loop pumps meanwhile. */
  async wait(condition, until) {
    while (true) {
      if (condition()) return true;
      if (now() >= until) return false;
      await sleep(25);
    }
  }

  /**
   * Before a stop: what the carriers have queued is given to the transports and answered, for a moment at most. A read
   * on the command line that got a message returns at once, and the receipt for it was queued in the same round.
   */
  async drain(seconds = 1) {
    if (![...this.running.values()].some((entry) => entry.carrier)) return;
    await this.wait(() => ![...this.running.values()].some((entry) => entry.carrier && entry.carrier.busy()), now() + seconds);
  }

  async stop() {
    this.stopping = true;
    if (this.loop) await this.loop;
    this.loop = null;
    // Out of what runs before the first of them is waited for, so one that is starting this moment stops itself.
    const entries = [...this.running.values()];
    this.running.clear();
    for (const entry of entries) if (entry.process) await entry.process.stop();
    // A start under way adds and starts nothing more now, and stops what it was starting itself. It is waited for,
    // so nothing of this service runs when stop returns and the owner lets go of the home. So is a start of a moment:
    // it sees the stop, stops its process and keeps nothing.
    await Promise.allSettled([...this.starts, ...this.learning.values()]);
  }

  status() {
    return Object.fromEntries([...this.running].map(([name, entry]) => [name, entry.carrier ? "up" : `down: ${entry.down ?? "waiting to start again"}`]));
  }

  /** The carrier of a transport now, or null while it waits to start again; transport_down when it will not run here. */
  #carrierOf(name) {
    const entry = this.running.get(name);
    if (!entry || entry.down !== null) throw coded("transport_down", `${name} cannot carry the message now: ${entry?.down ?? "it is not running in this process"}. Nothing was sent.`);
    return entry.carrier;
  }

  // ------------------------------------------------------------ in and out

  /** The newest session of this party's that still has room in its lifetime, or null. */
  #session(carrier, pk) {
    const chosen = this.profileFor(pk);
    return carrier.usableSession(pk, chosen.lifetime - chosen.challengeWindow);
  }

  /**
   * content to pk over its first transport, in an open session or in a new one: its mark, the sha256 of its envelope and
   * how far it came, and for the trace its size and whether it went sealed. The sha256 is the one the partner's runtime
   * reads it under and names as seen once it has read it.
   *
   * With stretch, the wait is as long as the medium needs as well, once its carrier is up and has said its rate: a session
   * and a message over sound take minutes. waited says how long it was.
   *
   * status is confirmed when the receipt came, handed_over when every frame of a try was given to the medium and no
   * receipt came within wait, queued when the message waits in the outbox for room, and unknown when its tries are used
   * without a receipt. A partner that gives no challenge within wait gets nothing: carry_not_sent.
   */
  async send(pk, content, wait = timing.waitDefault, stretch = false) {
    const route = this.routeOf(pk);
    if (!route) throw coded("transport_unbound", "that partner has no transport");
    const name = route.transport;
    const began = now();
    let until = began + wait;
    await this.start();
    if (stretch && (await this.wait(() => this.#carrierOf(name) !== null, until))) {
      const carrier = this.#carrierOf(name);
      if (carrier) until = Math.max(until, began + carrier.patience(content.length));
    }
    let asked = null;
    const opened = () => {
      // A carrier that started again after a stop knows nothing of the ask, so it asks again.
      const carrier = this.#carrierOf(name);
      if (!carrier) return false;
      if (this.#session(carrier, pk) !== null) return true;
      if (asked !== carrier) {
        // An ask under way, as one an earlier send made before it gave up, is answered all the same: a new one beside it
        // only adds frames, and on a half-duplex medium they take each other's turns.
        if (!carrier.asking(pk)) carrier.open(pk);
        asked = carrier;
      }
      return false;
    };
    if (!(await this.wait(opened, until))) {
      const hint = stretch ? "" : this.notSentHint(name, pk, content, until - began);
      throw coded("carry_not_sent", `the partner did not answer on ${name} within ${Math.floor(until - began)} seconds, so nothing was sent.${hint} Its aamio has to be `
        + `within reach of ${name} and running, as aamio serve or aamio read --wait, with this key bound to ${name}${this.#transportSaid(name, began)}`);
    }
    const carrier = this.#carrierOf(name);
    let key;
    try {
      key = carrier.send(pk, this.#session(carrier, pk), content);
    } catch (error) {
      if (error instanceof CarryRefused) throw coded(error.code, `${error.message}. Nothing was sent.`);
      throw error;
    }
    // What went, as the outbox keeps it: the envelope, and its sha256.
    const written = this.carry().durable.outbox[key];
    const envelope = Buffer.from(written.envelope, "hex");
    const state = this.carry();
    await this.wait(() => state.outcome(key) !== "waiting", until);
    let outcome = state.outcome(key);
    if (outcome === "waiting") outcome = this.running.get(name)?.carrier?.handedOver(key) ? "handed_over" : "queued";
    return { via: name, profile: route.profile, mark: key, status: outcome, sha256: written.sha256, bytes: envelope.length, sealed: envelope[MAGIC.length] === SEALED,
      waited: Math.floor(until - began) };
  }

  /**
   * What the transport said of the latest frame it could not send since the send began, for carry_not_sent, or an empty
   * string. It knows the medium: a Bluetooth address nobody answers on, a network that is down.
   */
  #transportSaid(name, since) {
    const said = this.running.get(name)?.process?.lastError ?? null;
    if (said === null || said.at < since || !said.message) return "";
    return `. ${name} said of the last frame it could not send: ${said.message.replace(/\.+$/, "")}`;
  }

  /**
   * What carry_not_sent adds when the wait was shorter than a send takes on the medium, as over MCP, where it is the work
   * budget: the ask goes on in the background, and a send after its answer came uses the session it opened. Empty
   * otherwise. Not private, so a test can give it a carrier over a slow medium.
   */
  notSentHint(name, pk, content, waited) {
    let carrier;
    try {
      carrier = this.#carrierOf(name);
    } catch {
      return "";
    }
    if (!carrier || waited >= carrier.patience(content.length)) return "";
    const due = carrier.askDue(pk);
    return due === null ? "" : ` The ask for a session is still under way on ${name}, and its answer is due in about ${Math.max(5, Math.floor(due))} seconds: send again then, and that send uses the session it opens.`;
  }

  /** What was sent over a transport, as aamio transport list shows it: mark and outcome, oldest first. */
  outbox() {
    const state = this.carry();
    return Object.keys(state.durable.outbox).map((key) => ({ mark: key, outcome: state.outcome(key) }));
  }

  /**
   * What came over a transport and the program has not taken, in read's shape and in the order it came. Each says the
   * transport and profile its partner is bound to now, and whether it came sealed and when, as the state kept it then.
   */
  entries(bodyJson, skip = new Set()) {
    const state = this.carry();
    let bindings;
    try {
      bindings = this.config.bindings();
    } catch {
      bindings = {};
    }
    const out = [];
    for (const [key, pk, , , content] of state.pending()) {
      if (skip.has(key)) continue;
      const kept = state.kept(key);
      const from = b64url(pk);
      const route = (bindings[from] ?? [])[0] ?? { transport: UNBOUND_CHANNEL, profile: null };
      const partner = this.runtime.partnerByKey(from);
      const [body, meta] = bodyOf(content, kept.sealed, bodyJson);
      out.push({ channel: route.transport, w: null, seq: null, at: kept.at, verified: true, from_key: from, known_contact: partner !== null, sender: partner ? partner.name : "unknown key",
        sha256: kept.sha256, replay: false, body, via: route.transport, profile: route.profile, mark: key, ...meta });
    }
    return out;
  }

  /** The program has these: the state keeps only their marks from now on. */
  taken(keys) {
    const state = this.carry();
    for (const key of keys) state.handedOver(key);
  }
}

// ------------------------------------------------------------ the commands

function partnerOf(runtime, which) {
  const partner = isKey(String(which)) ? runtime.partnerByKey(String(which)) : runtime.partnerByName(which);
  if (!partner) throw coded("unknown_partner", `unknown partner: ${which}. A transport carries messages between partners: aamio partner add NAME KEY first`);
  return partner;
}

/** aamio transport list: the transports enabled here, the profiles, which partner goes over which, and what was carried. */
export async function listing(runtime) {
  const service = runtime.transportService();
  const enabled = await service.manifests();
  const stored = service.config.profiles();
  const bindings = service.config.bindings();
  const kept = service.config.here();
  const addresses = service.config.addresses();
  const rows = Object.entries(bindings).map(([key, routes]) => {
    const partner = runtime.partnerByKey(key);
    const row = { partner: partner ? partner.name : null, key, in_address_book: partner !== null, routes };
    const reached = Object.entries(Object.hasOwn(addresses, key) ? addresses[key] : {}).filter(([transport]) => routes.some((route) => route.transport === transport));
    // Where the partner is reached on each transport: given to bind ("you") or shown by a fresh envelope ("heard").
    if (reached.length) row.addresses = Object.fromEntries(reached);
    return row;
  });
  const transports = [...enabled].map(([name, manifest]) => {
    const item = { name, version: manifest.version, medium: manifest.medium, permissions: [...manifest.permissions],
      partners: rows.filter((row) => row.in_address_book && row.routes.some((route) => route.transport === name)).map((row) => row.partner ?? row.key) };
    const said = Object.hasOwn(kept, name) ? kept[name] : null;
    if (said !== null && said.medium === manifest.medium) {
      item.here = said.here;
      item.here_at = said.at;
    } else {
      item.here = null;
      item.here_fix = `aamio transport here ${name} starts it for a moment and says where it is reached, for a card`;
    }
    return item;
  });
  const profiles = [...(Object.hasOwn(stored, DEFAULT_PROFILE) ? [] : [{ ...profileRecord(DEFAULT_PROFILE), stored: false }]), ...Object.values(stored).map((record) => ({ ...record, stored: true }))];
  const answer = { transports, profiles, bindings: rows, outbox: service.outbox(), pending: service.carry().pending().length };
  const missing = [...new Set(rows.filter((row) => row.in_address_book).flatMap((row) => row.routes.map((route) => route.transport)))].filter((name) => !enabled.has(name)).sort();
  if (missing.length) answer.note = `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} bound to a partner and not enabled here: aamio addon enable ${missing[0]}.`;
  else if (!transports.length) answer.note = "No transport is enabled here. A transport is an add-on: install one, as aamio-lan, and aamio addon enable lan.";
  return answer;
}

export function profileAdd(runtime, name, { readable = false, lifetime = null, window = null, maxContent = null } = {}) {
  const record = profileRecord(name, { mode: readable ? "readable" : "sealed", lifetime: lifetime ?? LIFETIME_DEFAULT, window: window ?? CHALLENGE_WINDOW_DEFAULT, maxContent: maxContent ?? MAX_CONTENT });
  runtime.transportService().config.addProfile(record);
  return { profile: record, note: readable ? "A readable profile signs and does not seal: everyone who hears the medium can read what goes under it. Bind it only where that is meant."
    : "Sealed: only the partner can read what goes under it, and everyone who hears the medium sees that it goes and how big it is." };
}

export function profileRemove(runtime, name) {
  runtime.transportService().config.removeProfile(name);
  return { removed: name };
}

/** aamio transport here NAME: where an enabled transport is reached, from the running one or a start of a moment. */
export async function here(runtime, name) {
  const service = runtime.transportService();
  const manifests = await service.manifests();
  if (!manifests.has(name)) {
    throw coded("transport_unknown", `no enabled transport is called ${name}. aamio addon list shows what is installed, and aamio addon enable ${name} lets it run here`);
  }
  const [found, how] = await service.learnHere(name);
  const medium = manifests.get(name).medium;
  if (how === "stopping") {
    return { transport: name, medium, here: null,
      note: `This runtime is letting go of the home, so ${name} was not started and nothing was learned. Ask again from the aamio that owns it now.` };
  }
  if (how === "starting") {
    return { transport: name, medium, here: null, note: `${name} is starting in this process and has not said it is ready yet: ask again in a moment.` };
  }
  if (how === "not_ready") {
    const said = service.downSaid?.get(name) ?? null;
    return { transport: name, medium, here: null,
      note: `${name} did not say it was ready within ${LEARN_SECONDS} seconds, so nothing was learned. `
        + (said ? `It said: ${said}` : "It said nothing of why, as when its medium is off or another program holds it.") };
  }
  // An empty list says nothing of where it is reached either, and has no first address to name.
  if (found === null || !found.length) {
    return { transport: name, medium, here: found,
      note: `${name} says nothing of where it is reached: a version from before here (contract 3, B3), or a medium without addresses. `
        + `A card can name the medium ${medium} without an address.` };
  }
  const started = how === "running" ? "It runs, and said so itself." : "It was started for a moment to say this, and stopped again.";
  return { transport: name, medium, here: found,
    note: `${started} ${found.join(", ")} is kept in the home for cards: over MCP an Earshot card that names ${medium} carries it by itself, and on the command line `
      + `aamio addon earshot card ADDRESS --via ${found[0]} --key KEY does. A partner binds it with aamio transport bind NAME TRANSPORT --address ${found[0]}.` };
}

/** A partner bound to a transport, or the address it is reached at there, for a partner bound to it already. */
export async function bind(runtime, which, transport, profileName = null, address = null) {
  const partner = partnerOf(runtime, which);
  const service = runtime.transportService();
  const manifests = await service.manifests();
  if (!manifests.has(transport)) {
    throw coded("transport_unknown", `no enabled transport is called ${transport}. aamio addon list shows what is installed, and aamio addon enable ${transport} lets it run here`);
  }
  const medium = manifests.get(transport).medium;
  if (address !== null && hereOf([address], medium) === null) {
    throw coded("transport_address_invalid", `an address on ${transport} is ${medium}: and then where the partner is reached, as its card or aamio transport here on its machine `
      + "says it, at most 128 characters of printable ASCII without spaces");
  }
  const bound = service.config.routes(partner.key).find((route) => route.transport === transport) ?? null;
  if (bound !== null && (address === null || (profileName !== null && profileName !== bound.profile))) {
    throw coded("transport_already_bound", `${transport} is bound to that partner already${address !== null
      ? `, under the profile ${bound.profile}: aamio transport unbind first to bind it under another` : ". With --address, bind says where the partner is reached on it"}`);
  }
  const routes = bound !== null ? service.config.routes(partner.key) : service.config.bind(partner.key, transport, profileName ?? DEFAULT_PROFILE);
  const answer = { partner: partner.name, key: partner.key, routes };
  if (address !== null) {
    service.config.setAddress(partner.key, transport, address, "you", unixNow());
    answer.address = address;
  }
  if (bound !== null) {
    answer.note = `The first ask to ${partner.name} on ${transport} goes to ${address} from now on; when it stops answering there, every second ask goes to nobody in particular, `
      + `and a fresh envelope from ${partner.name} moves the address to where it came from.`;
    return answer;
  }
  const reached = address !== null ? ` The first ask goes to ${address}; when it stops answering there, every second ask goes to nobody in particular, and a fresh envelope from ${partner.name} `
    + "moves the address to where it came from." : "";
  const first = routes[0].transport;
  answer.note = `Messages to ${partner.name} go over ${first} from now on, and never over HTTPS instead, and ${first} takes messages from ${partner.name}.${reached} ${partner.name} binds your key to ${transport} the same way. `
    + "Only the process that owns this home runs the transport: aamio serve, or aamio send and aamio read --wait while they run.";
  return answer;
}

export function unbind(runtime, which, transport = null) {
  const partner = partnerOf(runtime, which);
  const routes = runtime.transportService().config.unbind(partner.key, transport);
  return { partner: partner.name, key: partner.key, routes,
    note: routes.length ? `Messages to ${partner.name} go over ${routes[0].transport}.` : `Messages to ${partner.name} go over HTTPS again. What came over a transport and was not read is still read.` };
}
