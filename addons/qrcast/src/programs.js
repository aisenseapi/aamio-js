import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";

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

/** The full path of a program on PATH, or null. */
export function which(name, environ = process.env) {
  const windows = sep === "\\";
  const extensions = windows ? ["", ...String(environ.PATHEXT || ".EXE;.BAT;.CMD").split(";")] : [""];
  for (const folder of String(environ.PATH ?? environ.Path ?? "").split(delimiter)) {
    if (folder === "") continue;
    for (const extension of extensions) {
      const candidate = join(folder, name + extension.toLowerCase());
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not there, or not to be run: the next one.
      }
    }
  }
  return null;
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
