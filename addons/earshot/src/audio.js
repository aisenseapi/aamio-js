import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * Playing a WAV file and recording one, on the machine the add-on runs on.
 *
 * Node has no sound of its own, so a program does it. Playing: PowerShell's
 * Media.SoundPlayer on Windows, afplay on macOS, and paplay, pw-play, aplay or
 * ffplay on Linux. Recording: sox on Windows, sox or ffmpeg on macOS, and
 * arecord, sox or ffmpeg on Linux, as mono 16-bit PCM at 48 kHz, which
 * aisenseapi.com reads. Without one the answer says what to install. The
 * operating system asks the user once for the microphone: macOS for the app
 * the agent runs in, Windows under the privacy settings for desktop apps. On
 * Linux a sound server is reached through XDG_RUNTIME_DIR and PULSE_SERVER,
 * which the manifest asks for by name. The same programs as aamio-php's
 * Aamio\Earshot\Audio; aamio-python reaches the microphone itself.
 *
 * A program is started by its full path with its arguments as they are, and
 * never through a shell.
 */

/** The speaker or the microphone could not do it now. */
export class Unavailable extends Error {
  constructor(reason, fix) {
    super(fix);
    this.reason = reason;
    this.fix = fix;
  }
}

export function platform() {
  if (process.platform === "win32") return "win32";
  return process.platform === "darwin" ? "darwin" : "linux";
}

// PowerShell takes the typographic single quotes as quotes too, and doubling is how each is written inside a quoted string.
const quoted = (path) => `'${String(path).replace(/['‘’‚‛]/g, "$&$&")}'`;

export function players(path, system) {
  if (system === "win32") return [["powershell", "-NoProfile", "-NonInteractive", "-Command", `(New-Object Media.SoundPlayer ${quoted(path)}).PlaySync()`]];
  if (system === "darwin") return [["afplay", path]];
  return [["paplay", path], ["pw-play", path], ["aplay", "-q", path], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path]];
}

export function recorders(seconds, path, system) {
  const rec = ["rec", "-q", "-c", "1", "-r", "48000", "-b", "16", path, "trim", "0", String(seconds)];
  if (system === "win32") return [["sox", "-q", "-t", "waveaudio", "default", "-c", "1", "-r", "48000", "-b", "16", path, "trim", "0", String(seconds)]];
  if (system === "darwin") {
    return [rec, ["ffmpeg", "-loglevel", "error", "-f", "avfoundation", "-i", ":0", "-t", String(seconds), "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-y", path]];
  }
  return [
    ["arecord", "-q", "-f", "S16_LE", "-r", "48000", "-c", "1", "-d", String(seconds), path],
    rec,
    ["ffmpeg", "-loglevel", "error", "-f", "pulse", "-i", "default", "-t", String(seconds), "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-y", path],
  ];
}

function isProgram(candidate, windows) {
  try {
    const found = statSync(candidate);
    // On Windows a file with a program's ending is one; elsewhere somebody has to be allowed to run it.
    return found.isFile() && (windows || (found.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}


// Programs Windows brings, where Windows keeps them.
const SYSTEM = { cmd: ["System32"], powershell: ["System32", "WindowsPowerShell", "v1.0"] };

/** A full path on this machine: with a drive and a root, or a share, on Windows; from the root elsewhere. C:folder and \folder are not. */
export function isAbsolute(folder, hostWindows = process.platform === "win32") {
  if (hostWindows) return /^[A-Za-z]:[\\/]/.test(folder) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(folder);
  return folder.startsWith("/");
}

function sameFolder(folder, here, hostWindows) {
  const normal = (path) => {
    const flat = (hostWindows ? path.replace(/\//g, "\\") : path).replace(hostWindows ? /\\+$/ : /\/+$/, "");
    return hostWindows ? flat.toLowerCase() : flat;
  };
  if (normal(folder) === normal(here)) return true;
  try {
    return normal(realpathSync(folder)) === normal(realpathSync(here));
  } catch {
    return false;
  }
}

/**
 * The full path of a program, or null. It looks only in the folders PATH names
 * by a full path, leaves out the working directory however PATH names it, and
 * gives back the full path, which is what is started: a sox.exe in the folder
 * the agent ran from was the one that ran, and a PATH that began with . gave
 * back sox.exe, a name relative to wherever the agent was (a security review
 * of 13 November 2026, a review of 14 November). On Windows a program is an
 * .exe, since a batch file needs a shell and nothing here is started through
 * one, and cmd and powershell come from the folder Windows keeps them in.
 */
export function findProgram(name, { env = process.env, windows = process.platform === "win32", cwd = process.cwd(), hostWindows = process.platform === "win32", isProgram: isProgramHere = isProgram } = {}) {
  const get = (wanted) => Object.entries(env).find(([key]) => key.toUpperCase() === wanted)?.[1];
  const file = windows && !/\.exe$/i.test(name) ? name + ".exe" : name;
  const system = windows ? SYSTEM[name.toLowerCase()] : undefined;
  if (system) {
    const root = String(get("SYSTEMROOT") || "C:\\Windows");
    const candidate = [root.replace(/[\\/]+$/, ""), ...system, file].join("\\");
    if (isAbsolute(root, hostWindows) && isProgramHere(candidate, windows)) return candidate;
  }
  for (let folder of String(get("PATH") ?? "").split(windows ? ";" : ":")) {
    folder = folder.trim();
    if (windows) folder = folder.replace(/^"|"$/g, "");
    if (folder === "" || !isAbsolute(folder, hostWindows) || sameFolder(folder, cwd, hostWindows)) continue;
    const candidate = join(folder, file);
    if (isProgramHere(candidate, windows)) return candidate;
  }
  return null;
}

/** The same lookup, by the name it has had here. The same as the QRCast add-on's, and as aamio-python's and aamio-php's add-ons find their programs. */
export const which = findProgram;

function lastLine(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 200) : "no reason given";
}

/**
 * Run a program to the end, within so many seconds: null when it did, the
 * reason when it did not. command is the program's name and its arguments,
 * and program the full path it is started by.
 */
export function run(command, seconds, program = command[0]) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(why);
    };
    let child;
    try {
      child = spawn(program, command.slice(1), { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (error) {
      finish(`${command[0]} could not be started: ${error.message}`);
      return;
    }
    const said = [];
    let size = 0;
    child.stderr.on("data", (chunk) => {
      // The last line is what is said, so the end of what it wrote is what is kept.
      said.push(chunk);
      size += chunk.length;
      while (said.length > 1 && size - said[0].length >= 65536) size -= said.shift().length;
    });
    child.on("error", (error) => finish(`${command[0]} could not be started: ${error.message}`));
    child.on("close", (code, signal) => {
      if (code === 0) finish(null);
      else finish(`${command[0]} stopped with code ${code ?? signal}: ${lastLine(Buffer.concat(said).toString("utf8"))}`);
    });
    timer = setTimeout(() => {
      finish(`${command[0]} did not finish within ${seconds} seconds`);
      try {
        child.kill("SIGKILL");
      } catch {
        // Gone already.
      }
      child.stderr.destroy();
      child.unref();
    }, seconds * 1000);
  });
}

/** Play the file to the end, and say what played it. Unavailable when nothing here can. */
export async function play(path, { find = which, start = run, system = platform() } = {}) {
  const failed = [];
  for (const command of players(path, system)) {
    const program = find(command[0]);
    if (program !== null) {
      const why = await start(command, 60, program);
      if (why === null) return command[0];
      failed.push(why);
    }
  }
  if (failed.length) {
    throw new Unavailable("player_failed", `The sound could not be played: ${failed.join("; ")}. Check the speaker and the volume, or write the sound to a file with --out (out over MCP) and play it another way.`);
  }
  throw new Unavailable("no_player", "Nothing on this machine plays a sound file: install pulseaudio-utils (paplay), alsa-utils (aplay) or ffmpeg, or write the sound to a file with --out (out over MCP) and play it another way.");
}

/** Record this many seconds from the default microphone into path, and say what recorded it. */
export async function record(seconds, path, { find = which, start = run, system = platform() } = {}) {
  const failed = [];
  for (const command of recorders(seconds, path, system)) {
    const program = find(command[0]);
    if (program !== null) {
      const why = await start(command, seconds + 15, program);
      if (why === null) return command[0];
      failed.push(why);
    }
  }
  if (failed.length) {
    throw new Unavailable("recorder_failed", `Nothing was recorded: ${failed.join("; ")}. Check that a microphone is connected and that this app may use it: macOS asks once for the app the agent runs in, Windows has it under the privacy settings for desktop apps.`);
  }
  const install = system === "win32"
    ? "On Windows, SoX comes with winget install ChrisBagwell.SoX, and is found once the terminal is started again"
    : "Install sox, or alsa-utils (arecord) or ffmpeg on Linux";
  throw new Unavailable("no_recorder", `Nothing on this machine records from the microphone. ${install}, or record the sound another way and read the file with aamio addon earshot decode FILE (aamio_addon_earshot_decode).`);
}
