import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The system, the programs on PATH, and one program run to its end within a
// time. The add-on brings no program of its own: zbarimg reads the codes,
// ffmpeg takes the frames, and the system's own viewer shows a picture. Each
// is started by its full path with its arguments as a list, never through a
// shell, so nothing in a path or a camera's name is read as a command.

// The most that is kept of what a program wrote: its output and its errors.
const MAX_OUT = 1048576;
const MAX_ERR = 65536;

/** win32, darwin or linux: the three ways the screen, the camera and the reader are reached. */
export function platform() {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

/** Whether a file is a program here: on Windows an .exe is one; elsewhere somebody has to be allowed to run it. */
function programAt(candidate, windows) {
  try {
    const found = statSync(candidate);
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
export function findProgram(name, { env = process.env, windows = process.platform === "win32", cwd = process.cwd(), hostWindows = process.platform === "win32", isProgram = programAt } = {}) {
  const get = (wanted) => Object.entries(env).find(([key]) => key.toUpperCase() === wanted)?.[1];
  const file = windows && !/\.exe$/i.test(name) ? name + ".exe" : name;
  const system = windows ? SYSTEM[name.toLowerCase()] : undefined;
  if (system) {
    const root = String(get("SYSTEMROOT") || "C:\\Windows");
    const candidate = [root.replace(/[\\/]+$/, ""), ...system, file].join("\\");
    if (isAbsolute(root, hostWindows) && isProgram(candidate, windows)) return candidate;
  }
  for (let folder of String(get("PATH") ?? "").split(windows ? ";" : ":")) {
    folder = folder.trim();
    if (windows) folder = folder.replace(/^"|"$/g, "");
    if (folder === "" || !isAbsolute(folder, hostWindows) || sameFolder(folder, cwd, hostWindows)) continue;
    const candidate = join(folder, file);
    if (isProgram(candidate, windows)) return candidate;
  }
  return null;
}

/** The full path of a program, from the folders PATH names by a full path and never the working directory, or null. */
export function which(name, environ = process.env, options = {}) {
  return findProgram(name, { env: environ, ...options });
}

/**
 * Run a program to the end within so many seconds, and give its exit code,
 * its output and its errors as [code, out, err]. The code is null when it did
 * not finish, and it was stopped; -1 when it could not be started at all.
 * With verbatim, on Windows, the arguments go as they are written, with the
 * quotes the caller put there and no others.
 */
export function run(command, seconds, { verbatim = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command[0], command.slice(1), { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: verbatim });
    } catch {
      resolve([-1, "", `${command[0]} could not be started`]);
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let stopped = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    child.stdout.on("data", (chunk) => {
      if (outBytes < MAX_OUT) out.push(chunk.subarray(0, MAX_OUT - outBytes));
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      if (errBytes < MAX_ERR) err.push(chunk.subarray(0, MAX_ERR - errBytes));
      errBytes += chunk.length;
    });
    const timer = setTimeout(() => {
      stopped = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Gone already.
      }
      // A program that was stopped and still holds its pipes is not waited for.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish([null, Buffer.concat(out).toString("utf8"), Buffer.concat(err).toString("utf8")]);
      }, 2000).unref();
    }, seconds * 1000);
    child.on("error", () => finish([-1, "", `${command[0]} could not be started`]));
    child.on("close", (code) => finish([stopped ? null : code, Buffer.concat(out).toString("utf8"), Buffer.concat(err).toString("utf8")]));
  });
}

/** The last line a program said, for the reason it gives when it fails. */
export function lastLine(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.length ? lines[lines.length - 1].slice(0, 200) : "no reason given";
}

/** A folder of this call's own in the temporary directory, private from the start. Throws what the system said when it cannot be made. */
export function makeFolder() {
  const made = join(tmpdir(), "aamio-qrcast-" + randomBytes(8).toString("hex"));
  mkdirSync(made, { mode: 0o700 });
  return made;
}

/** The same, or null when it cannot be made. */
export function folder() {
  try {
    return makeFolder();
  } catch {
    return null;
  }
}

/** Take a folder of this call's own away again, with the files in it. */
export function clean(made) {
  try {
    for (const name of readdirSync(made)) {
      try {
        unlinkSync(join(made, name));
      } catch {
        // Held by a viewer, or gone: the folder stays, as the system's to tidy.
      }
    }
    rmdirSync(made);
  } catch {
    // Not there any more.
  }
}
