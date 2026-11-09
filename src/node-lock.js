import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { DEFAULT_BASE } from "./aamio.js";

/*
 * One live runtime per home, whichever client it is. aamio-python and
 * aamio-php take the operating system's lock on owner.lock for as long as they
 * run: flock() on Linux and macOS, a lock on its first byte on Windows, which
 * PHP's flock() covers by locking the whole file. The system lets go of it when
 * the process ends, however it ends, so no lock outlives its owner and none is
 * ever taken by age.
 *
 * Node has no flock(). Each system gets the nearest thing the other clients'
 * lock sees, so that a home has one owner whichever client starts first:
 *
 *   Windows  owner.lock opened with no sharing: libuv's UV_FS_O_EXLOCK, which
 *            Node passes through but does not name. While Python or PHP holds
 *            the file open and locked, the open fails with EBUSY. While Node
 *            holds it, they cannot open it, and refuse the home.
 *   Linux    util-linux flock locks a duplicate of Node's open file descriptor
 *            and exits. The lock stays on the shared open file description
 *            until Node closes its handle or exits.
 *   BSD      O_EXLOCK with the open, which is flock()'s lock, on macOS and the
 *            BSDs. Not yet tried on a Mac.
 *
 * Where none of these can be had, the home is not taken: held by nobody and
 * not by this one either, nothing proves it free.
 */

export const OWNER_LOCK = "owner.lock";
// The pid file the other clients write beside owner.lock. It names the owner
// in the message a second runtime gives, and os_lock says its writer held the
// lock, so a runtime that holds the lock now knows that writer is gone.
export const PID_FILE = "lock";

// libuv opens the file with no sharing for this flag on Windows.
const WINDOWS_NO_SHARING = 0x10000000;
// BSD's O_EXLOCK, the same value on macOS, FreeBSD and OpenBSD.
const BSD_EXLOCK = 0x20;
const BSD = ["darwin", "freebsd", "openbsd"];

// Homes this process holds, for a plainer message when it asks twice.
const held = new Set();

function lockError(code, message) {
  return Object.assign(new Error(message), { code });
}

function unavailable(home, path, why) {
  return lockError("lock_unavailable",
    `cannot establish exclusive ownership of ${home}: ${path} could not be opened or locked (${why}). ` +
    "Restore file access or locking support, or use a different AAMIO_HOME on a local disk.");
}

/** Opens owner.lock in a way that only one process can hold it. The holder, or null when another holds it. */
async function holdWithOpen(home, path, flags, busy) {
  let handle;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_CREAT | flags, 0o600);
  } catch (error) {
    if (busy.includes(error.code)) return null;
    throw unavailable(home, path, error.code || error.message);
  }
  return { release: () => handle.close() };
}

/** Pass Node's descriptor as fd 3. flock(1) exits before the caller starts serving. */
async function holdWithFlock(home, path, command) {
  const conflict = 42; // Outside util-linux's sysexits range and distinct from generic failure (1).
  let handle;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_CREAT, 0o600);
    const child = spawn(command, ["-x", "-n", "-E", String(conflict), "3"], {
      stdio: ["ignore", "ignore", "pipe", handle.fd],
    });
    let diagnostic = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { diagnostic += chunk; });
    const [code, signal] = await once(child, "close");
    if (code === 0) return { release: () => handle.close() };
    if (code !== conflict) {
      throw new Error(diagnostic.trim() || `flock ended with ${signal || code}`);
    }
  } catch (error) {
    await handle?.close();
    const reason = handle && error.code === "ENOENT"
      ? "the flock command was not found: install util-linux"
      : error.code || error.message;
    throw unavailable(home, path, reason);
  }
  await handle.close();
  return null;
}

/** The operating system's lock on owner.lock. The holder, or null when another process holds it. */
export async function holdOwnerLock(home, { flock = "flock", platform = process.platform } = {}) {
  const path = join(home, OWNER_LOCK);
  if (platform === "win32") return holdWithOpen(home, path, WINDOWS_NO_SHARING, ["EBUSY"]);
  if (BSD.includes(platform)) return holdWithOpen(home, path, BSD_EXLOCK | constants.O_NONBLOCK, ["EAGAIN", "EWOULDBLOCK"]);
  if (platform === "linux") return holdWithFlock(home, path, flock);
  throw unavailable(home, path, `no lock the other clients see is known for ${platform}`);
}

async function readPidFile(home) {
  try {
    const value = JSON.parse(await readFile(join(home, PID_FILE), "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function writePidFile(home, value) {
  const path = join(home, PID_FILE);
  const temporary = join(home, `lock.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** True, false, or null when it cannot be told: a pid that answers signal 0 is alive, and one that is not there is not. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return null;
  }
}

/**
 * An owner the lock cannot see: a client from before owner.lock, which wrote
 * the pid file alone. One that held the lock says so with os_lock, and is gone,
 * since this process holds the lock now. Not known to be gone is not gone.
 */
async function checkOlderOwner(home) {
  const last = await readPidFile(home);
  if (!last || !Number.isSafeInteger(last.pid) || last.pid === process.pid || last.os_lock === true) return;
  const alive = pidAlive(last.pid);
  if (alive === null) {
    throw lockError("home_in_use",
      `could not determine whether aamio (pid ${last.pid}) is still using ${home}; the lock is left untouched. ` +
      "Stop the other runtime, or use a different AAMIO_HOME. Do not remove the lock unless you have confirmed its owner has stopped.");
  }
  if (alive) {
    throw lockError("home_in_use",
      `another aamio (pid ${last.pid}) is using ${home}. Stop it, or use a different AAMIO_HOME. If no aamio is running, ` +
      `the one that took the lock stopped without letting go of it: delete ${join(home, PID_FILE)} and start again.`);
  }
}

/**
 * Takes a home for this process, as the other clients do: owner.lock held,
 * and the pid file written with os_lock. Throws home_in_use when another
 * runtime has it, and lock_unavailable when the lock cannot be had at all.
 * release() lets go of both, the pid file first, so a runtime that takes the
 * lock the moment it is free finds none of this one's to wonder about.
 */
export async function takeHome(home, { host = process.env.AAMIO_HOST || DEFAULT_BASE, ...options } = {}) {
  const real = await realpath(home);
  if (held.has(real)) throw lockError("home_in_use", `another aamio in this process is already using ${home}`);
  const holder = await holdOwnerLock(home, options);
  if (holder === null) {
    const last = await readPidFile(home);
    const named = Number.isSafeInteger(last?.pid) ? ` (pid ${last.pid})` : "";
    throw lockError("home_in_use", `another aamio${named} is using ${home}. Stop it, or use a different AAMIO_HOME.`);
  }
  try {
    await checkOlderOwner(home);
    await writePidFile(home, { pid: process.pid, at: Math.floor(Date.now() / 1000), host, os_lock: true });
  } catch (error) {
    await holder.release();
    throw error;
  }
  held.add(real);
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const last = await readPidFile(home);
      if (last?.pid === process.pid) await unlink(join(home, PID_FILE)).catch(() => {});
      await holder.release();
      held.delete(real);
    },
  };
}
