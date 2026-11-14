// aamio doctor for the Node runtime: one answer to three questions, as aamio-python and aamio-php give it. Does this
// client fit the service, who can read the home, and what is kept. Nothing here is a guess reported as a finding:
// what could not be checked says so, and is never called fine. The compatibility check and the check of the home are
// aamio-python's (aamio/compat.py and aamio/storage.py), with the same verdicts and the same words, so the three
// runtimes say the same of one home and one service.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// ------------------------------------------------------------------ compatibility

export const PROTOCOL = 1;

// Without these there is nothing this client can do.
export const NEEDS = ["threads", "signing", "long-poll"];

// With these it does more. What each one is for, so a missing one can be explained to whoever asks.
export const USES = {
  allowlist: "opening an inbox only named keys, or only signed messages, may write to",
  reset: "being told when a cursor belongs to an earlier thread at the address",
  gate: "reading what an inbox asks of writers before sending",
  pow: "doing the proof of work an inbox asks for",
  receipts: "taking a receipt for a thread",
  presence: "publishing and looking up where a key can be reached",
  board: "the open board of needs and offers",
  scopes: "unlisted posts for a group of agents",
  "read-limits": "asking for a small answer with X-Limit and X-Max-Bytes, so a busy thread does not arrive all at once",
  "sealed-claim": "having the service refuse a message that calls itself sealed and is readable",
  "canonical-keys": "one key being one string, so allowlists and a reader's own check compare the same strings",
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Whether this client and a service fit, decided from what the service says it can do in its descriptor, as read
 * from /.well-known/aamio.json. full: every capability this client uses is declared; partial: the client works and
 * some of what it offers will not; refuse: another protocol, or something the client cannot work without is missing.
 */
export function compatCheck(descriptor) {
  const declared = isObject(descriptor) ? descriptor.protocol : null;
  const details = { client_protocol: PROTOCOL, service_version: isObject(descriptor) ? (descriptor.version ?? null) : null };
  if (!isObject(declared) || !Array.isArray(declared.capabilities)) {
    return Object.assign(details, {
      verdict: "partial",
      why: "This service does not declare a protocol or its capabilities, as services before 0.7.1 did not. The client works with those as far as it has been tested, and cannot tell from here what is missing.",
      missing: [],
    });
  }
  details.service_protocol = declared.version ?? null;
  const offered = new Set(declared.capabilities.map((item) => String(item)));
  if (declared.version !== PROTOCOL) {
    return Object.assign(details, { verdict: "refuse", missing: [], why: `The service speaks protocol ${JSON.stringify(declared.version ?? null)} and this client speaks ${PROTOCOL}. Use a client made for that protocol.` });
  }
  const lacking = NEEDS.filter((name) => !offered.has(name));
  if (lacking.length) {
    return Object.assign(details, { verdict: "refuse", missing: lacking, why: `The service does not offer ${lacking.join(", ")}, and this client cannot work without it.` });
  }
  const missing = Object.keys(USES).filter((name) => !offered.has(name));
  details.missing = missing;
  details.unknown_to_this_client = [...offered].filter((name) => !NEEDS.includes(name) && !(name in USES)).sort();
  if (missing.length) {
    return Object.assign(details, { verdict: "partial", why: "The client works with this service. Not offered there: " + missing.map((name) => `${name} (${USES[name]})`).join("; ") + "." });
  }
  return Object.assign(details, { verdict: "full", why: "Everything this client uses is offered by this service." });
}

// ------------------------------------------------------------------ who can read the home

// Who may have access to a private folder on Windows without it being a finding: the system itself, the
// administrators of the machine, and whoever created or owns the file. Everything else is somebody else.
const WINDOWS_EXPECTED = new Set(["S-1-5-18", "S-1-5-32-544", "S-1-3-0", "S-1-3-4"]);

// SDDL writes the well known accounts as two letters and everyone else as a full SID. An alias not here stays as
// the two letters it was written as, which reads as an account nobody recognises and is reported: the safe direction
// for a check about who can read your keys.
const SDDL_SIDS = {
  BA: "S-1-5-32-544", SY: "S-1-5-18", CO: "S-1-3-0", CG: "S-1-3-1", WD: "S-1-1-0", AU: "S-1-5-11", BU: "S-1-5-32-545",
  BG: "S-1-5-32-546", PU: "S-1-5-32-547", IU: "S-1-5-4", NU: "S-1-5-2", AN: "S-1-5-7", LS: "S-1-5-19", NS: "S-1-5-20",
  RC: "S-1-5-12", OW: "S-1-3-4", AC: "S-1-15-2-1", AO: "S-1-5-32-548", SO: "S-1-5-32-549", PO: "S-1-5-32-550",
  BO: "S-1-5-32-551", RE: "S-1-5-32-552", RU: "S-1-5-32-554", SU: "S-1-5-6", PS: "S-1-5-10", ED: "S-1-5-9",
};

const WINDOWS_NAMES = {
  "S-1-1-0": "Everyone",
  "S-1-5-11": "Authenticated Users",
  "S-1-5-32-545": "Users",
  "S-1-5-32-546": "Guests",
  "S-1-5-4": "Interactive",
};

/** Findings from `sid|rights|type` lines, one per access rule. me is the current user's SID. */
export function windowsAclFindings(lines, me) {
  const findings = [];
  for (const line of lines) {
    const parts = String(line).trim().split("|").map((part) => part.trim());
    if (parts.length !== 3 || parts[0] === "" || parts[2].toLowerCase() !== "allow") continue;
    const [sid, rights] = parts;
    if (sid === me || WINDOWS_EXPECTED.has(sid)) continue;
    const who = WINDOWS_NAMES[sid] ?? sid;
    findings.push({ who, rights, problem: `${who} has access to this folder (${rights}), so the key and everything else in it can be read by others on this machine` });
  }
  return findings;
}

/**
 * A Windows tool by its place in System32, so another whoami.exe earlier on the path is not the one asked: Git Bash
 * puts its own first, which answers /user with a usage error, and the second way read nothing.
 */
function systemTool(...parts) {
  // Never the bare name, which Windows looks for in the working directory first (a security review of 13 November
  // 2026): where System32 has no such tool, starting it fails, as it should.
  return join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", ...parts);
}

function run(command, args) {
  const done = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (done.error) throw done.error;
  if (done.status !== 0) throw Object.assign(new Error(String(done.stderr || done.stdout || `${command} failed`).trim().slice(0, 200)), { code: "EFAILED" });
  return done.stdout;
}

/** The folder's access rules, read with Get-Acl, and the current user's SID. */
export function windowsRulesGetAcl(path, runner = run) {
  const quoted = String(path).replaceAll("'", "''");
  const script = "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; 'me|' + $me; "
    + `(Get-Acl -LiteralPath '${quoted}').Access | ForEach-Object { `
    + "$sid = try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $_.IdentityReference.Value }; "
    + "'{0}|{1}|{2}' -f $sid, $_.FileSystemRights, $_.AccessControlType }";
  const lines = runner(systemTool("WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script]).split(/\r?\n/).filter((line) => line.trim());
  const meLine = lines.find((line) => line.startsWith("me|"));
  return { me: meLine ? meLine.slice(3).trim() : "", rules: lines.filter((line) => !line.startsWith("me|")) };
}

const unsupported = (message) => Object.assign(new Error(message), { name: "ValueError" });

/** icacls writes UTF-16. Read strictly, so a file cut short is not read as a shorter list. */
function utf16(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
  const body = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2) : bytes;
  return new TextDecoder("utf-16le", { fatal: true }).decode(body);
}

/**
 * The same rules as Get-Acl, read with two .exe calls and no PowerShell module: whoami for the SID, and icacls for
 * the folder's access list as SDDL, which gives SIDs where what icacls prints gives account names in the machine's
 * language. Returns what windowsRulesGetAcl returns, so one parser reads both.
 */
export function windowsRulesIcacls(path, runner = run, readExport = (file) => readFileSync(file)) {
  const fields = runner(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"]).trim().split(",").map((part) => part.trim().replaceAll('"', ""));
  const me = fields.length ? fields[fields.length - 1] : "";
  if (!me.startsWith("S-1-")) throw unsupported("whoami did not give a SID");
  // Resolved once, so a relative path and its exported name are the same folder. icacls /save writes the final name only.
  const target = resolve(path);
  const folder = mkdtempSync(join(tmpdir(), "aamio-acl-"));
  let exported;
  try {
    const saved = join(folder, "acl.txt");
    runner(systemTool("icacls.exe"), [target, "/save", saved]);
    exported = utf16(readExport(saved)).split(/\r\n|\n|\r/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  if (exported.length && exported[exported.length - 1] === "") exported.pop();
  if (exported.length !== 2 || exported[0].toLowerCase() !== basename(target).toLowerCase()) {
    throw unsupported("icacls did not export exactly the requested folder");
  }
  // The complete access list, not fragments of a cut one. NO_ACCESS_CONTROL is not an empty private list. A root can
  // carry S: as well, its integrity label, which grants nothing: only the D: rules belong here.
  const matched = /^D:(?:P|AI|AR)*((?:\([^()]*\))*)(?:S:(?:P|AI|AR)*(?:\([^()]*\))*)?$/.exec(exported[1]);
  if (!matched) throw unsupported("icacls wrote an incomplete or unsupported access control list");
  const rules = [];
  for (const [, ace] of matched[1].matchAll(/\(([^()]*)\)/g)) {
    const parts = ace.split(";");
    if (parts.length !== 6) throw unsupported("icacls wrote an unsupported access rule");
    const [kind, rights, sid] = [parts[0].trim(), parts[2].trim(), parts[5].trim()];
    if (!["A", "D"].includes(kind) || !rights || !sid || parts[3] || parts[4]) throw unsupported("icacls wrote an incomplete or unsupported access rule");
    // A is allow, and only allow rules say who can read this. A deny rule that takes access away is not a finding.
    if (kind === "D") continue;
    rules.push(`${SDDL_SIDS[sid.toUpperCase()] ?? sid}|${rights}|allow`);
  }
  return { me, rules };
}

const errorName = (error) => error?.code === "ENOENT" ? "FileNotFoundError" : error?.code === "ETIMEDOUT" ? "TimeoutExpired" : error?.name === "ValueError" ? "ValueError" : "OSError";

/**
 * Who can read the home, as far as this platform lets us find out. private is true, false, or null when it could not
 * be checked, and a null is never reported as a yes.
 */
export function homeCheck(home, { platform = process.platform, getAcl = windowsRulesGetAcl, icacls = windowsRulesIcacls } = {}) {
  const result = { home, private: null, how: null, findings: [] };
  let folder;
  try {
    folder = statSync(home);
  } catch {
    folder = null;
  }
  if (!folder || !folder.isDirectory()) {
    result.how = "not checked: there is no such folder yet";
    return result;
  }
  if (platform === "win32") {
    result.how = "the folder's access control list, read with Get-Acl. Mode bits say nothing on Windows.";
    let read;
    try {
      read = getAcl(home);
    } catch (first) {
      // Get-Acl lives in a PowerShell module that does not load everywhere. icacls is an .exe and needs none.
      try {
        read = icacls(home);
        result.how = `the folder's access control list, read with icacls after Get-Acl was not available (${errorName(first)}). Mode bits say nothing on Windows.`;
      } catch (second) {
        result.how = `not checked: the access control list could not be read, by Get-Acl (${errorName(first)}) or by icacls (${errorName(second)})`;
        result.fix = `Run \`icacls "${home}"\` and see that only you, SYSTEM and Administrators are listed.`;
        return result;
      }
    }
    result.findings = windowsAclFindings(read.rules, read.me);
    result.private = result.findings.length === 0;
    if (result.findings.length) result.fix = `Remove the inherited access and keep your own: icacls "${home}" /inheritance:r /grant:r "%USERNAME%":(OI)(CI)F`;
    return result;
  }
  result.how = "owner and mode bits of the folder and every file in it";
  const me = typeof process.getuid === "function" ? process.getuid() : null;
  const visit = (path, isFolder) => {
    let found;
    try {
      found = statSync(path);
    } catch {
      return;
    }
    if (me !== null && found.uid !== me) result.findings.push({ path, problem: `owned by another user (uid ${found.uid})` });
    else if (found.mode & 0o077) result.findings.push({ path, problem: `readable by others (mode ${(found.mode & 0o777).toString(8)})` });
    if (!isFolder) return;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) visit(join(path, entry.name), entry.isDirectory());
  };
  visit(home, true);
  result.private = result.findings.length === 0;
  if (result.findings.length) result.fix = `chmod -R go-rwx "${home}"`;
  return result;
}

// ------------------------------------------------------------------ the answer

/** GET a path of the service: the status and the body, and 0 with no body when no answer came. */
async function ask(runtime, path) {
  try {
    const response = await runtime.client.fetch(runtime.client.base + path, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    // Whether the text was JSON is kept beside what it gave: null and "" in JSON
    // are answers, and were said as an empty body (a review of 13 November 2026).
    let body = null;
    let json = false;
    try {
      if (text) {
        body = JSON.parse(text);
        json = true;
      }
    } catch {
      body = text;
    }
    return { status: response.status, body, json };
  } catch {
    return { status: 0, body: null, json: false };
  }
}

/**
 * What /health said when it is not aamio's health answer, an object with
 * "service": "aamio" and "status": "ok" as the service gives it, and null when
 * it is. A 200 from a proxy or a login page in front of the host was said as
 * healthy, beside "answered 200 and not 200" (a check of 13 November 2026).
 */
function notHealth(body, json) {
  if (!json) return body === null || body === "" ? "an empty body" : "a body that is not JSON";
  if (!isObject(body) || body.service !== "aamio" || body.status !== "ok") return "JSON that is not aamio's health answer";
  return null;
}

/** One answer to three questions: does this client fit the service, who can read the home, what is kept. */
export async function doctor(runtime, version) {
  const health = await ask(runtime, "/health");
  // Whether the service answered and whether it is well are two things, and
  // both apart from whether this client fits it. A 503 from /health was said
  // as no answer, beside a fit read from the descriptor, which had answered
  // (a check of 13 November 2026). As aamio-python and aamio-php say it.
  const unlike = health.status === 200 ? notHealth(health.body, health.json) : null;
  const service = { host: runtime.host, reachable: health.status > 0, healthy: health.status === 200 && unlike === null, status: health.status };
  if (service.healthy) {
    service.version = health.body.version ?? null;
    service.revision = health.body.revision ?? null;
  } else if (health.status === 0) {
    service.problem = "no answer from /health, so the service's version and health were not read";
  } else if (health.status !== 200) {
    service.problem = `/health answered ${health.status} and not 200: the service is reachable and not healthy, and its version was not read`;
  } else {
    service.problem = `/health answered 200 with ${unlike}, so the service's version and health were not read: check that --host names the aamio service and not a page in front of it`;
  }
  const descriptor = await ask(runtime, "/.well-known/aamio.json");
  const fits = compatCheck(descriptor.status === 200 ? descriptor.body : null);
  if (descriptor.status !== 200) {
    fits.verdict = "unknown";
    fits.why = `the descriptor could not be read (${descriptor.status}), so compatibility was not checked`;
  }
  return {
    client: { name: "aamio-js", version, protocol: PROTOCOL },
    service,
    compatibility: fits,
    storage: homeCheck(runtime.home),
    archive: await runtime.archiveStatus(),
    outbox_pending: runtime.outboxPending().length,
  };
}
