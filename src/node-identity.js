import { constants } from "node:fs";
import { lstat, mkdtemp, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Keys } from "./aamio.js";

function identityError(code, message) {
  return Object.assign(new Error(message), { code });
}

const missingHome = () => identityError("home_not_initialized", "No Aamio home exists at the selected path.");
const badKey = () => identityError("key_unreadable", "The Aamio home must contain a readable key file with a 64-character lowercase hexadecimal seed.");
const initFailed = () => identityError("home_init_failed", "Could not create a private Aamio home. Choose a new directory under an existing writable parent on a local disk.");

function publicIdentity(keys) {
  return { key: keys.public, hash: keys.hash, hash_prefix: keys.hash.slice(0, 8) };
}

/** Read only the public identity of a local Aamio home. No runtime or owner lock is opened. */
export async function readIdentity(home) {
  return publicIdentity(await readKeys(home));
}

/** The keys of a local Aamio home, for a runtime that holds the home. The seed stays in memory. */
export async function readKeys(home) {
  if (typeof home !== "string" || !home) throw missingHome();
  try {
    await lstat(home);
  } catch (error) {
    if (error.code === "ENOENT") throw missingHome();
    throw badKey();
  }

  const file = join(home, "key");
  let handle;
  try {
    if (!(await lstat(file)).isFile()) throw badKey();
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 64 || stat.size > 4096) throw badKey();
    // Bound the read even if a different process changes the file after stat().
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used !== stat.size) throw badKey();
    const match = /^[ \t\v\r\n]*([0-9a-f]{64})[ \t\v\r\n]*$/.exec(bytes.toString("utf8", 0, used));
    if (!match) throw badKey();
    return Keys.fromSeedHex(match[1]);
  } catch {
    throw badKey();
  } finally {
    if (handle) await handle.close();
  }
}

// This empty folder receives the seed only after its DACL is protected and verified.
// The key inherits the current user's rule. No path or key is interpolated into a command.
const windowsAcl = `
$ErrorActionPreference = 'Stop'
$path = $env:AAMIO_INIT_STAGE
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', $inherit, 'None', 'Allow')
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($path, $acl)
$actual = [System.IO.Directory]::GetAccessControl($path)
$rules = $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or
    $rules[0].IdentityReference.Value -ne $me.Value -or $rules[0].AccessControlType -ne 'Allow' -or
    $rules[0].InheritanceFlags -ne $inherit -or $rules[0].FileSystemRights -ne 'FullControl') { exit 1 }
`;

async function protectWindowsFolder(folder) {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await promisify(execFile)(powershell, ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", windowsAcl], {
    windowsHide: true, timeout: 15000,
    env: { SystemRoot: systemRoot, AAMIO_INIT_STAGE: folder },
  });
}

async function syncFolder(folder) {
  if (process.platform === "win32") return;
  const directory = await open(folder, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function discardStage(folder) {
  // These are the only two paths this invocation created. Never walk a home or remove its locks.
  try {
    await unlink(join(folder, "key"));
  } catch (error) {
    if (error.code !== "ENOENT") throw initFailed();
  }
  try {
    await rmdir(folder);
  } catch (error) {
    if (error.code !== "ENOENT") throw initFailed();
  }
}

/** Initialize an absent home, or read its existing identity. No other runtime state is written. */
export async function initIdentity(home) {
  if (typeof home !== "string" || !home) throw missingHome();
  const destination = resolve(home);
  try {
    return await readIdentity(destination);
  } catch (error) {
    if (error.code !== "home_not_initialized") throw error;
  }
  const parent = dirname(destination);
  let stage;
  try {
    stage = await mkdtemp(join(parent, ".aamio-init-"));
    if (process.platform === "win32") await protectWindowsFolder(stage);
    const keys = Keys.generate();
    const keyFile = await open(join(stage, "key"), "wx", 0o600);
    try {
      await keyFile.writeFile(Buffer.from(keys.seed).toString("hex") + "\n", "utf8");
      await keyFile.sync();
    } finally {
      await keyFile.close();
    }
    await syncFolder(stage);
    try {
      return await readIdentity(destination);
    } catch (error) {
      if (error.code !== "home_not_initialized") throw error;
    }
    // POSIX rename can replace a completely empty directory created in this last instant.
    // It cannot replace a directory containing a key, an owner lock, or any runtime state.
    try {
      await rename(stage, destination);
    } catch (moveError) {
      try {
        return await readIdentity(destination);
      } catch (readError) {
        if (readError.code === "key_unreadable") throw readError;
        throw moveError;
      }
    }
    stage = undefined;
    await syncFolder(parent);
    return publicIdentity(keys);
  } catch (error) {
    if (error.code === "key_unreadable") throw error;
    throw initFailed();
  } finally {
    if (stage) await discardStage(stage);
  }
}
