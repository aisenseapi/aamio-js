import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Unreachable } from "./errors.js";
import * as programs from "./programs.js";

/*
 * Frames from a camera on this machine, through ffmpeg.
 *
 * ffmpeg opens the camera, with DirectShow on Windows, AVFoundation on macOS
 * and Video4Linux on Linux, and writes grey frames, four a second, as PGM
 * images to a pipe. No frame touches the disk here: each is read and dropped.
 * Sound is never taken. ffmpeg is the one program the add-on needs for this:
 * on Windows it comes with winget install Gyan.FFmpeg, and winget's link
 * folder is looked in as well, so an agent started before the install finds
 * it; on macOS with brew install ffmpeg, and on Linux as the ffmpeg package.
 *
 * The operating system decides who may use the camera: Windows under the
 * privacy settings for desktop apps, macOS once for the app the agent runs
 * in, and Linux by the video group. The same as aamio-python's
 * aamio_qrcast.camera and aamio-php's Camera.
 */

export const FPS = 4;
export const MAX_SIDE = 4096;
const WINGET_LINK = ["Microsoft", "WinGet", "Links", "ffmpeg.exe"];
const NOT_FRAMES = "ffmpeg wrote something other than the grey frames asked for.";
// How much of what ffmpeg said of an error is kept.
const SAID_BYTES = 8192;

export function installHint(platform) {
  if (platform === "win32") return "On Windows, ffmpeg comes with winget install Gyan.FFmpeg.";
  if (platform === "darwin") return "On macOS, ffmpeg comes with brew install ffmpeg.";
  return "On Linux, it is the ffmpeg package, as apt install ffmpeg.";
}

export function privacyHint(platform) {
  if (platform === "win32") return "Check that the camera is connected and not in use, and that desktop apps may use it: Settings, Privacy, Camera.";
  if (platform === "darwin") return "macOS asks once for the app the agent runs in: Privacy & Security, Camera.";
  return "Check that the camera is connected and that this user is in the video group.";
}

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** ffmpeg on the path, or in winget's link folder on Windows, or null. */
export function findFfmpeg(which = programs.which, platform = programs.platform(), environ = process.env) {
  const found = which("ffmpeg");
  if (found !== null) return found;
  const base = environ.LOCALAPPDATA;
  // A LOCALAPPDATA that is no full path would be the working directory.
  if (platform === "win32" && typeof base === "string" && base !== "" && programs.isAbsolute(base)) {
    const link = join(base, ...WINGET_LINK);
    if (isFile(link)) return link;
  }
  return null;
}

/** The cameras ffmpeg sees, by the names it takes them by. */
export async function listCameras(ffmpeg, platform, run = programs.run) {
  if (platform !== "win32" && platform !== "darwin") {
    try {
      return readdirSync("/dev").filter((name) => /^video[0-9]+$/.test(name)).map((name) => "/dev/" + name).sort();
    } catch {
      return [];
    }
  }
  const command = platform === "win32"
    ? [ffmpeg, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]
    : [ffmpeg, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""];
  const [, , text] = await run(command, 20);
  if (platform === "darwin") {
    const section = (text.split("AVFoundation video devices:")[1] ?? "").split("AVFoundation audio devices:")[0];
    return [...section.matchAll(/\]\s+\[[0-9]+\]\s+(.+?)\s*$/gm)].map((match) => match[1]);
  }
  const names = [...text.matchAll(/"([^"]+)"\s+\(video\)/g)].map((match) => match[1]);
  if (!names.length && text.includes("DirectShow video devices")) {
    // An older ffmpeg lists the cameras under a heading, each on a line of its own.
    const section = text.split("DirectShow video devices").slice(1).join("DirectShow video devices").split("DirectShow audio devices")[0];
    for (const line of section.split(/\r?\n/)) {
      const match = /\]\s+"([^"@][^"]*)"\s*$/.exec(line);
      if (match) names.push(match[1]);
    }
  }
  return names;
}

export async function defaultCamera(ffmpeg, platform, run = programs.run) {
  if (platform === "win32") {
    const names = await listCameras(ffmpeg, platform, run);
    if (!names.length) throw new Unreachable("no_camera", "ffmpeg finds no camera on this machine. " + privacyHint(platform));
    return names[0];
  }
  if (platform === "darwin") return "0";
  if (!existsSync("/dev/video0")) {
    throw new Unreachable("no_camera", "There is no /dev/video0 on this machine. Connect a camera, or name one with --camera (camera over MCP), as /dev/video2.");
  }
  return "/dev/video0";
}

export function inputFor(platform, camera) {
  if (platform === "win32") return ["-f", "dshow", "-i", "video=" + camera];
  if (platform === "darwin") return ["-f", "avfoundation", "-framerate", "30", "-i", camera];
  return ["-f", "v4l2", "-i", camera];
}

/** What ffmpeg writes, taken a byte or so many bytes at a time. */
export class Pipe {
  constructor(stream) {
    this.chunks = stream[Symbol.asyncIterator]();
    this.held = Buffer.alloc(0);
  }

  /** The next byte, or null at the end of the stream. */
  async byte() {
    const one = await this.take(1);
    return one === null ? null : one[0];
  }

  /** The next so many bytes, or null when the stream ends before them. */
  async take(length) {
    const parts = this.held.length ? [this.held] : [];
    let have = this.held.length;
    this.held = Buffer.alloc(0);
    while (have < length) {
      let next;
      try {
        next = await this.chunks.next();
      } catch {
        // A pipe that broke gives no more frames: how ffmpeg ended says the rest.
        return null;
      }
      const { value, done } = next;
      if (done) return null;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      parts.push(chunk);
      have += chunk.length;
    }
    const all = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    this.held = all.subarray(length);
    return all.subarray(0, length);
  }
}

/** One P5 frame from ffmpeg's pipe, as [width, height, bytes], or null at the end of the stream. */
export async function readPgm(pipe) {
  const fields = [];
  let token = "";
  while (fields.length < 4) {
    let byte = await pipe.byte();
    if (byte === null) return null;
    if (byte === 0x23 && token === "") {
      // A comment, to the end of its line.
      while (byte !== 0x0a && byte !== null) byte = await pipe.byte();
      continue;
    }
    if (byte === 0x20 || (byte >= 0x09 && byte <= 0x0d)) {
      if (token !== "") {
        fields.push(token);
        token = "";
      }
      continue;
    }
    token += String.fromCharCode(byte);
    if (token.length > 10) throw new Unreachable("camera_failed", NOT_FRAMES);
  }
  const [magic, wide, high, depth] = fields;
  if (magic !== "P5" || !/^[0-9]+$/.test(wide) || !/^[0-9]+$/.test(high) || depth !== "255") throw new Unreachable("camera_failed", NOT_FRAMES);
  const width = Number(wide);
  const height = Number(high);
  if (width < 1 || width > MAX_SIDE || height < 1 || height > MAX_SIDE) {
    throw new Unreachable("camera_failed", `ffmpeg gave a frame of ${width} x ${height} pixels, and at most ${MAX_SIDE} a side are read.`);
  }
  const data = await pipe.take(width * height);
  return data === null ? null : [width, height, data];
}

/**
 * ffmpeg started on a command, as frames() uses it: its standard output, what
 * it said of an error, a way to stop it, and its exit code once it has ended.
 */
export function start(command) {
  const child = spawn(command[0], command.slice(1), { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const said = [];
  let kept = 0;
  let failed = null;
  let code;
  const ended = new Promise((resolve) => {
    child.on("error", (error) => {
      failed = error;
      resolve(null);
    });
    child.on("exit", (status) => {
      code = status;
      resolve(status);
    });
  });
  child.stderr.on("data", (chunk) => {
    if (kept < SAID_BYTES) said.push(chunk.subarray(0, SAID_BYTES - kept));
    kept += chunk.length;
  });
  const within = (seconds) => Promise.race([ended, new Promise((resolve) => setTimeout(resolve, seconds * 1000, undefined).unref())]);
  return {
    stdout: child.stdout,
    said: () => Buffer.concat(said).toString("utf8"),
    failed: () => (failed === null ? null : failed.message),
    async wait() {
      await within(10);
      return code === undefined ? null : code;
    },
    async stop() {
      if (code === undefined && failed === null) {
        child.kill();
        await within(5);
        if (code === undefined && failed === null) {
          child.kill("SIGKILL");
          await within(2);
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

/**
 * Grey frames from the camera, four a second, for this many seconds, as
 * [width, height, bytes]. Leaving the loop stops ffmpeg.
 */
export async function* frames(seconds, camera = null, { which = programs.which, platform = programs.platform(), environ = process.env, begin = start, run = programs.run } = {}) {
  const ffmpeg = findFfmpeg(which, platform, environ);
  if (ffmpeg === null) {
    throw new Unreachable("no_ffmpeg", `ffmpeg, which reads the camera, is not on this machine. ${installHint(platform)} Or take a picture another way and read it with aamio addon qrcast read FILE (aamio_addon_qrcast_read).`);
  }
  const chosen = camera ?? (await defaultCamera(ffmpeg, platform, run));
  const command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", ...inputFor(platform, chosen),
    "-t", String(seconds), "-an", "-vf", `fps=${FPS},format=gray`, "-f", "image2pipe", "-c:v", "pgm", "-"];
  let running;
  try {
    running = begin(command);
  } catch (error) {
    throw new Unreachable("camera_failed", `ffmpeg could not be started: ${error.message}.`);
  }
  const pipe = new Pipe(running.stdout);
  let got = 0;
  try {
    for (;;) {
      const frame = await readPgm(pipe);
      if (frame === null) break;
      got++;
      yield frame;
    }
    const code = await running.wait();
    const failed = running.failed?.() ?? null;
    if (failed !== null) throw new Unreachable("camera_failed", `ffmpeg could not be started: ${failed}.`);
    if (got === 0) {
      throw new Unreachable("camera_failed", `ffmpeg gave no picture from the camera ${chosen}: ${programs.lastLine(running.said())}. ${privacyHint(platform)}`);
    }
    // The pictures stop either because the time is up, and ffmpeg ends well,
    // or because the camera went away, and ffmpeg ends with an error. Only the
    // exit code tells the two apart: without it a camera unplugged halfway
    // would read as a scan in which no code was seen.
    if (code !== null && code !== 0) {
      throw new Unreachable("camera_failed", `The camera ${chosen} stopped giving pictures after ${got}, and ffmpeg ended with exit code ${code}: ${programs.lastLine(running.said())}. Check that the camera is connected and not taken by another program, and scan again.`);
    }
  } finally {
    await running.stop();
  }
}
