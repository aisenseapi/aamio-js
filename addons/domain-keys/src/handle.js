// The answer to one request of contract 2 of aamio's add-ons, written up at
// https://aamio.at/docs/addons. The core has already settled what is the
// core's: the website is one the user agreed to, the subject carries the key
// it resolved from the address book or from a signature it checked, and
// own_key is the runtime's public key where a command needs it. Nothing here
// opens the home.
//
//     kind    command | tool | probe
//     name    file | validate | check | aamio_addon_domain_check
//
// An answer is {"result": ..., "exit_code": n, "is_error": bool}, or
// {"raw": base64} for bytes that go to standard output as they are, with
// "stderr" for a line to the user.
import { readFileSync } from "node:fs";
import { DOMAIN_KEYS_PATH, InvalidDomainKeys, checkFile, makeDomainKeys } from "./lists.js";
import * as policy from "./policy.js";

export const CONTRACT = 2;
const manifest = JSON.parse(readFileSync(new URL("../aamio-addon.json", import.meta.url), "utf8"));
export const NAME = manifest.name;
export const VERSION = manifest.version;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function answer({ result = null, exitCode = 0, isError = null, raw = null, stderr = null } = {}) {
  const said = { exit_code: exitCode, is_error: isError === null ? exitCode !== 0 : isError };
  if (raw !== null) said.raw = Buffer.from(raw).toString("base64");
  else said.result = result;
  if (stderr) said.stderr = stderr;
  return said;
}

/** The answer to one request. network goes to the read, for tests. */
export async function handle(request, network = {}) {
  if (!isObject(request) || request.aamio_addon !== CONTRACT) {
    return answer({ result: { error: `this add-on speaks contract ${CONTRACT} of aamio's add-ons, and the request is not on it`, fix: "Upgrade aamio, or install the version of aamio-domain-keys made for yours." }, exitCode: 2, isError: true });
  }
  const { kind, name } = request;
  const given = isObject(request.arguments) ? request.arguments : {};
  if (kind === "probe") return answer({ result: { ok: true, name: NAME, version: VERSION, aamio_addon: CONTRACT } });
  if (kind === "command" && name === "file") {
    let raw;
    try {
      raw = makeDomainKeys([{ key: request.own_key, name: given.name ?? null }]);
    } catch (error) {
      if (!(error instanceof InvalidDomainKeys)) throw error;
      // To the user and not to standard output: `aamio addon domain file > aamio-keys.json`
      // would publish the complaint.
      return answer({ exitCode: 2, isError: true, stderr: JSON.stringify({ error: error.reason, fix: "--name is a label of 1 to 64 characters of a-z, 0-9, dot, underscore and dash." }) });
    }
    return answer({ raw, stderr: `aamio: this holds your public key and nothing secret. Publish it at https://YOUR-DOMAIN${DOMAIN_KEYS_PATH}, with no login and no redirect, on a domain you already control.` });
  }
  if (kind === "command" && name === "validate") {
    const [result, exitCode] = await checkFile(given.file);
    return answer({ result, exitCode });
  }
  if ((kind === "command" && name === "check") || (kind === "tool" && name === "aamio_addon_domain_check")) {
    const found = await policy.check(given.domain, request.subject, given.name ?? null, network);
    return answer({ result: found, exitCode: policy.EXIT_CODES[found.status], isError: "fix" in found });
  }
  return answer({ result: { error: `the add-on ${NAME} has no ${kind} called ${name}`, fix: `aamio addon ${NAME} --help lists its commands, and aamio addon list its tools.` }, exitCode: 2, isError: true });
}
