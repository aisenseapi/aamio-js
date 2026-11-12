// The process aamio runs for each call: one JSON request on standard input,
// one JSON answer on standard output.
//
//     node process.js < request.json
//
// The request says kind (probe, command or tool), name and arguments; the
// answer carries result, exit_code and is_error. The whole contract is at
// https://aamio.at/docs/addons. Nothing of this package is loaded by aamio
// itself: aamio-addon.json beside this file says what it offers.
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./aamio-addon.json", import.meta.url), "utf8"));

export function handle(request) {
  if (request.kind === "probe") return { result: { ok: true, name: "hello", version, aamio_addon: 2 }, exit_code: 0 };
  const given = request.arguments ?? {};
  return { result: { hello: given.to || "world" }, exit_code: 0, is_error: false };
}

let text = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) text += chunk;
process.stdout.write(JSON.stringify(handle(JSON.parse(text))) + "\n");
