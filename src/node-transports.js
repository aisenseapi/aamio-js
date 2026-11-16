// Transports for one home, for Node (contract 3, B): the profiles, the bindings to partners, and the service the owner
// of the home runs.
//
// The home keeps, under transports/: profiles.json, the security profiles of B5; bindings.json, for each partner's key
// an ordered list of a transport and a profile; and carry.json, the carrier state of aamio-carry-v1-tilstand. The same
// files as aamio-python's transports.py and aamio-php's Transports write, so a home moves between the runtimes. A
// partner without a binding goes over HTTPS as before; a partner with one goes over its transport only, and never over
// HTTPS instead.
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
import { TransportFailed, TransportProcess, environment } from "./node-transport-host.js";

export const PROFILE_VERSION = 1;
export const DEFAULT_PROFILE = "sealed";
export const CRASH_WINDOW = 600;
export const CRASHES_MOST = 3;
// What a carried message is filed under when the partner it came from is no longer bound to a transport.
export const UNBOUND_CHANNEL = "carry";
// How often a running carrier's list of whom it takes messages from is read again, and what runs is held against the
// bindings: a partner removed meanwhile is taken from no longer than this after, and a transport nobody is bound to any
// more runs no longer than this after.
export const KNOWN_REFRESH = 2;
// How long a transport that stopped waits before it is started again, and how long a send waits; a test may shorten them.
export const timing = { restartAfter: [1, 5, 30], waitDefault: 30 };

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const now = () => performance.now() / 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const coded = (code, message) => Object.assign(new Error(message), { code });
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64url = (text) => new Uint8Array(Buffer.from(text, "base64url"));

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
    return routes;
  }

  routes(key) {
    return this.bindings()[key] ?? [];
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
    for (const [name, entry] of this.running) {
      if (!entry.carrier) continue;
      try {
        entry.carrier.known = this.knownFor(name);
      } catch (error) {
        entry.carrier.known = [];
        this.runtime.log?.(`transport ${name}: ${error.message}`);
      }
    }
  }

  async #startDue() {
    const at = now();
    for (const [name, entry] of this.running) {
      if (this.stopping) return;
      if (entry.carrier || entry.starting || !entry.manifest || entry.down !== null || at < entry.next) continue;
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
        entry.carrier = new Carrier(this.carry(), transport, (pk) => this.profileFor(pk), this.knownFor(name),
          { log: (line) => this.runtime.log?.(line), note: (text) => this.#say(name, text) });
        entry.process = transport;
        this.runtime.log?.(`transport ${name}: up`);
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
    // so nothing of this service runs when stop returns and the owner lets go of the home.
    await Promise.allSettled([...this.starts]);
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
   * status is confirmed when the receipt came, handed_over when every frame of a try was given to the medium and no
   * receipt came within wait, queued when the message waits in the outbox for room, and unknown when its tries are used
   * without a receipt. A partner that gives no challenge within wait gets nothing: carry_not_sent.
   */
  async send(pk, content, wait = timing.waitDefault) {
    const route = this.routeOf(pk);
    if (!route) throw coded("transport_unbound", "that partner has no transport");
    const name = route.transport;
    const until = now() + wait;
    await this.start();
    let asked = null;
    const opened = () => {
      // A carrier that started again after a stop knows nothing of the ask, so it asks again.
      const carrier = this.#carrierOf(name);
      if (!carrier) return false;
      if (this.#session(carrier, pk) !== null) return true;
      if (asked !== carrier) {
        carrier.open(pk);
        asked = carrier;
      }
      return false;
    };
    if (!(await this.wait(opened, until))) {
      throw coded("carry_not_sent", `the partner did not answer on ${name} within ${wait} seconds, so nothing was sent. Its aamio has to run on the same network, as aamio serve or aamio read --wait, with this key bound to ${name}`);
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
    return { via: name, profile: route.profile, mark: key, status: outcome, sha256: written.sha256, bytes: envelope.length, sealed: envelope[MAGIC.length] === SEALED };
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
  const rows = Object.entries(service.config.bindings()).map(([key, routes]) => {
    const partner = runtime.partnerByKey(key);
    return { partner: partner ? partner.name : null, key, in_address_book: partner !== null, routes };
  });
  const transports = [...enabled].map(([name, manifest]) => ({ name, version: manifest.version, medium: manifest.medium, permissions: [...manifest.permissions],
    partners: rows.filter((row) => row.in_address_book && row.routes.some((route) => route.transport === name)).map((row) => row.partner ?? row.key) }));
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

export async function bind(runtime, which, transport, profileName = null) {
  const partner = partnerOf(runtime, which);
  const service = runtime.transportService();
  if (!(await service.manifests()).has(transport)) {
    throw coded("transport_unknown", `no enabled transport is called ${transport}. aamio addon list shows what is installed, and aamio addon enable ${transport} lets it run here`);
  }
  const routes = service.config.bind(partner.key, transport, profileName ?? DEFAULT_PROFILE);
  const first = routes[0].transport;
  return { partner: partner.name, key: partner.key, routes,
    note: `Messages to ${partner.name} go over ${first} from now on, and never over HTTPS instead, and ${first} takes messages from ${partner.name}. ${partner.name} binds your key to ${transport} the same way. `
      + "Only the process that owns this home runs the transport: aamio serve, or aamio send and aamio read --wait while they run." };
}

export function unbind(runtime, which, transport = null) {
  const partner = partnerOf(runtime, which);
  const routes = runtime.transportService().config.unbind(partner.key, transport);
  return { partner: partner.name, key: partner.key, routes,
    note: routes.length ? `Messages to ${partner.name} go over ${routes[0].transport}.` : `Messages to ${partner.name} go over HTTPS again. What came over a transport and was not read is still read.` };
}
