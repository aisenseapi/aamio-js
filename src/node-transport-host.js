// The host side of contract 3, for Node: one transport process, its lines, its room and its frames.
//
// The specification is part B of docs/aamio-tillegg-kontrakt-3-2026-11-15.md in
// the service repository. A transport is a dumb pipe: it moves frames and says
// what its medium can. Room is only what a ready gives, credit after the sends
// the transport had read, so lines that cross still leave one answer (B3.1).
// The first answer for a frame decides its status, also after its deadline
// (B3.2). A transport is hung when three frames in a row reach their deadline
// unanswered, or when frames wait 60 seconds for room no ready gave; what else
// it says does not count as progress.

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { b64url, unb64url } from "./aamio.js";
import * as carry from "./carry.js";
import { CarryRefused } from "./carry.js";
import { ENVIRONMENT } from "./node-addon-process.js";

export const LINE_LIMIT = 262144;
export const DESCRIBE_SECONDS = 10;
export const STOP_SECONDS = 5;
export const HANG_TIMEOUTS = 3;
export const HANG_ROOM_SECONDS = 60;
export const FRAME_GROUPS = 32;
export const FRAME_BYTES = 262144;
export const FRAME_SECONDS = 120;
const NEVER_PASSED = new Set(["AAMIO_HOME", "AAMIO_ADDONS", "AAMIO_ADDON"]);
const realSeconds = () => performance.now() / 1000;

/** The transport cannot be used as it is: it said something the contract does not allow, or stopped answering. */
export class TransportFailed extends Error {
  constructor(code, detail = "") {
    super(code + (detail ? ": " + detail : ""));
    this.name = "TransportFailed";
    this.code = code;
  }
}

/** Contract 2's short list of variables, AAMIO_ADDON=3 and what the manifest declares; never the home's whereabouts. */
export function environment(declared, base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) if (ENVIRONMENT.has(key.toUpperCase())) env[key] = value;
  for (const name of declared) if (!NEVER_PASSED.has(name.toUpperCase()) && name in base) env[name] = base[name];
  env.AAMIO_ADDON = "3";
  return env;
}

const isWhole = (value) => Number.isInteger(value);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** B4: what describe says about the medium, inside its bounds, or TransportFailed. */
export function checkProperties(properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new TransportFailed("transport_bad_describe", "properties is not an object");
  for (const key of ["max_frame_up", "max_frame_down"]) {
    if (!isWhole(properties[key]) || properties[key] < 10 || properties[key] > 65535) throw new TransportFailed("transport_bad_describe", `${key} is a whole number of 10 to 65535 bytes`);
  }
  for (const key of ["rate_up", "rate_down"]) {
    if (!isNumber(properties[key]) || properties[key] <= 0) throw new TransportFailed("transport_bad_describe", `${key} is a positive number of bytes a second`);
  }
  for (const [key, allowed] of [["direction", ["duplex", "half", "send_only", "receive_only"]], ["addressing", ["none", "device", "routed"]], ["metadata_visible_to", ["range", "local", "operator"]]]) {
    if (!allowed.includes(properties[key])) throw new TransportFailed("transport_bad_describe", `${key} is one of ${allowed.join(", ")}`);
  }
  for (const key of ["link_ack", "medium_encrypts"]) if (typeof properties[key] !== "boolean") throw new TransportFailed("transport_bad_describe", `${key} is true or false`);
  const airtime = properties.airtime;
  if (airtime !== null && airtime !== undefined && !(isNumber(airtime.percent) && airtime.percent > 0 && airtime.percent <= 100 && isWhole(airtime.window_s) && airtime.window_s > 0)) {
    throw new TransportFailed("transport_bad_describe", "airtime is null or {percent, window_s}");
  }
  return properties;
}

export class TransportProcess {
  // describeSeconds is the contract's 10 unless a test on a loaded machine needs longer for a process to start.
  constructor(name, version, command, cwd, env, { clock = realSeconds, log = () => {}, describeSeconds = DESCRIBE_SECONDS } = {}) {
    Object.assign(this, { name, version, command, cwd, env, clock, log, describeSeconds });
    this.child = null;
    this.lines = [];          // what has come and not been taken: ["line", text] | ["closed"] | ["too_long"]
    this.wake = null;
    this.buffer = "";
    this.properties = null;
    this.written = 0;
    this.credit = 0;
    this.sendsRead = 0;
    this.frames = new Map();
    this.counter = 0;
    this.timeoutsInARow = 0;
    this.waitingForRoomSince = null;
    this.failed = null;
  }

  // ---------------------------------------------------------- the process

  async start(aamioVersion, runtime, stateDir) {
    this.child = spawn(this.command[0], this.command.slice(1), { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let at;
      while ((at = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        this.#arrive(Buffer.byteLength(line) > LINE_LIMIT ? ["too_long"] : ["line", line]);
      }
      if (Buffer.byteLength(this.buffer) > LINE_LIMIT) this.#arrive(["too_long"]);
    });
    this.child.stderr.setEncoding("utf8");
    let errors = "";
    this.child.stderr.on("data", (chunk) => {
      errors = (errors + chunk).slice(-65536);
      let at;
      while ((at = errors.indexOf("\n")) !== -1) {
        this.log(`transport ${this.name}: ${errors.slice(0, at).trimEnd()}`);
        errors = errors.slice(at + 1);
      }
    });
    this.child.on("error", () => this.#arrive(["closed"]));
    this.child.on("exit", () => this.#arrive(["closed"]));
    this.child.stdin.on("error", () => {});
    this.#write({ t: "hello", aamio_addon: 3, aamio: { version: aamioVersion, runtime }, state_dir: stateDir });
    const until = realSeconds() + this.describeSeconds;
    while (this.properties === null) {
      if (realSeconds() >= until) this.#fail(new TransportFailed("transport_timeout", `no describe within ${this.describeSeconds} seconds of hello`));
      await this.poll(200);
    }
    return this.properties;
  }

  #arrive(item) {
    this.lines.push(item);
    if (this.wake) {
      const wake = this.wake;
      this.wake = null;
      wake();
    }
  }

  #write(message) {
    if (this.failed) throw this.failed;
    try {
      this.child.stdin.write(JSON.stringify(message) + "\n");
    } catch {
      this.#fail(new TransportFailed("transport_down", "the process does not take what is written to it"));
    }
  }

  #fail(failure) {
    if (!this.failed) {
      this.failed = failure;
      this.log(`transport ${this.name}: ${failure.message}`);
    }
    throw this.failed;
  }

  /** B2: stop, five seconds to go in real time, then killed. The stop line goes also after a failure. */
  async stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      child.stdin.write('{"t":"stop"}\n');
      child.stdin.end();
    } catch {
      // The process may be gone already.
    }
    const timer = new Promise((resolve) => setTimeout(resolve, STOP_SECONDS * 1000, "late"));
    if ((await Promise.race([exited, timer])) === "late") {
      child.kill();
      await exited;
    }
  }

  // ---------------------------------------------------------- room and frames

  room() {
    return this.credit - (this.written - this.sendsRead);
  }

  /** Give the transport a frame if there is room: its id, or null when there is no room now. */
  send(frame, to = null, deadlineMs = 30000) {
    if (this.room() <= 0) {
      if (this.waitingForRoomSince === null) this.waitingForRoomSince = this.clock();
      return null;
    }
    this.counter += 1;
    const id = `f-${this.counter}`;
    this.#write({ t: "send", id, to, frame: b64url(frame), deadline_ms: deadlineMs });
    this.written += 1;
    this.frames.set(id, { status: "waiting", deadline: this.clock() + deadlineMs / 1000, late: false, answered: false });
    return id;
  }

  status(id) {
    return this.frames.get(id).status;
  }

  /** B3.2: frames past their deadline become unknown and are cancelled; a transport without progress is hung. */
  checkTime() {
    const now = this.clock();
    for (const [id, entry] of this.frames) {
      if (entry.status === "waiting" && now > entry.deadline) {
        entry.status = "unknown";
        this.timeoutsInARow += 1;
        try {
          this.#write({ t: "cancel", id });
        } catch {
          // Failed already: the check below says so.
        }
      }
    }
    if (this.timeoutsInARow >= HANG_TIMEOUTS) this.#fail(new TransportFailed("transport_hung", `${this.timeoutsInARow} frames in a row reached their deadline without an answer`));
    if (this.waitingForRoomSince !== null && now - this.waitingForRoomSince >= HANG_ROOM_SECONDS) this.#fail(new TransportFailed("transport_hung", "frames waited 60 seconds for room no ready gave"));
  }

  /** What the transport said since last time, waiting up to timeoutMs for the first line: a list of events. */
  async poll(timeoutMs = 0) {
    if (this.lines.length === 0 && timeoutMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.wake = null;
          resolve();
        }, timeoutMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    const events = [];
    while (this.lines.length) {
      for (const event of this.#take(this.lines.shift())) events.push(event);
    }
    return events;
  }

  /** A line put in by hand, for the tests. */
  inject(text) {
    this.lines.push(["line", text]);
  }

  #take(item) {
    if (item[0] === "closed") this.#fail(new TransportFailed("transport_down", "the process ended"));
    if (item[0] === "too_long") this.#fail(new TransportFailed("transport_protocol", `a line longer than ${LINE_LIMIT} bytes`));
    let message;
    try {
      message = JSON.parse(item[1]);
    } catch {
      this.#fail(new TransportFailed("transport_protocol", "a line that is not JSON"));
    }
    if (!message || typeof message !== "object" || typeof message.t !== "string") this.#fail(new TransportFailed("transport_protocol", "a line without t"));
    switch (message.t) {
      case "describe":
        if (this.properties === null) {
          if (message.name !== this.name || message.version !== this.version || message.aamio_addon !== 3) {
            this.#fail(new TransportFailed("transport_bad_describe", "describe names another add-on, version or contract than its manifest"));
          }
          try {
            this.properties = checkProperties(message.properties);
          } catch (failure) {
            this.#fail(failure);
          }
        }
        return [];
      case "ready": {
        const { credit, sends_read: sendsRead } = message;
        if (!isWhole(credit) || credit < 0 || !isWhole(sendsRead) || sendsRead < this.sendsRead || sendsRead > this.written) {
          this.#fail(new TransportFailed("transport_protocol", "ready with credit and sends_read that do not add up"));
        }
        const before = this.room();
        this.credit = credit;
        this.sendsRead = sendsRead;
        if (this.room() > Math.max(before, 0)) this.waitingForRoomSince = null;
        return [];
      }
      case "sent":
      case "error":
      case "link_ack": {
        if (message.t === "error" && message.id == null) {
          this.log(`transport ${this.name}: ${message.message ?? message.code}`);
          return [];
        }
        const answered = this.#answer(message);
        return answered ? [["answer", answered]] : [];
      }
      case "received": {
        const source = message.from ?? null;
        if (source !== null && (typeof source !== "string" || source.length > 128)) this.#fail(new TransportFailed("transport_protocol", "from is a string of at most 128 characters, or null"));
        if (typeof message.frame !== "string") this.#fail(new TransportFailed("transport_protocol", "a received frame that is not base64url"));
        return [["received", source, unb64url(message.frame)]];
      }
      case "status":
        return [["status", message.state ?? null, message.reason ?? null]];
      default:
        this.#fail(new TransportFailed("transport_protocol", `an unknown line ${message.t}`));
    }
    return [];
  }

  #answer(message) {
    const entry = this.frames.get(message.id);
    if (!entry) {
      this.log(`transport ${this.name}: an answer for a frame it was never given`);
      return null;
    }
    if (message.t === "link_ack") {
      if (entry.status === "sent") entry.linkAck = true;
      return null;
    }
    if (!["waiting", "unknown"].includes(entry.status) || entry.answered) {
      this.log(`transport ${this.name}: a second answer for ${message.id} is not taken`);
      return null;
    }
    entry.answered = true;
    if (entry.status === "unknown") entry.late = true;
    else this.timeoutsInARow = 0;
    if (message.t === "sent") entry.status = "sent";
    else {
      entry.status = "not_sent";
      entry.reason = String(message.code ?? "error");
    }
    return message.id;
  }
}

/** Frames from the medium, sorted by tag into envelopes, within the limits of A10. */
export class Reassembly {
  constructor(clock = realSeconds) {
    this.clock = clock;
    this.groups = new Map();
  }

  add(frame) {
    const now = this.clock();
    for (const [tag, group] of this.groups) if (now - group.first > FRAME_SECONDS) this.groups.delete(tag);
    if (frame.length < carry.FRAME_HEADER + 1) throw new CarryRefused("frame_bad_length");
    const tag = Array.from(frame.slice(3, 7)).join(",");
    let group = this.groups.get(tag);
    if (!group) {
      while (this.groups.size && (this.groups.size >= FRAME_GROUPS || [...this.groups.values()].reduce((sum, g) => sum + g.bytes, 0) + frame.length > FRAME_BYTES)) {
        let oldest = null;
        for (const [key, g] of this.groups) if (oldest === null || g.first < this.groups.get(oldest).first) oldest = key;
        this.groups.delete(oldest);
      }
      group = { first: now, frames: [], bytes: 0 };
      this.groups.set(tag, group);
    }
    group.frames.push(frame);
    group.bytes += frame.length;
    if (new Set(group.frames.map((f) => f[7])).size < frame[8]) {
      try {
        carry.reassemble(group.frames);
      } catch (error) {
        if (error instanceof CarryRefused && error.code !== "frame_incomplete") {
          this.groups.delete(tag);
          throw error;
        }
      }
      return null;
    }
    this.groups.delete(tag);
    return carry.reassemble(group.frames);
  }
}
