// Add-ons as npm leaves them in a home: the home's own folder for add-ons with its package.json, and under
// node_modules a package with its package.json, its manifest and the script the core runs for each call. Nothing
// here runs npm: the files are written as an install writes them.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The process of the test add-on: what it does is chosen by the last word of the command's or the tool's name. */
export const PROCESS = `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let text = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) text += chunk;
const request = JSON.parse(text);
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "process.ran"), request.kind + " " + request.name + "\\n");
const say = (value) => new Promise((resolve) => process.stdout.write(JSON.stringify(value) + "\\n", resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fill = (stream, letter, count) => new Promise((resolve) => stream.write(letter.repeat(count), resolve));

if (request.kind === "probe") {
  if (process.env.AAMIO_TEST_PASSTHRU !== undefined) {
    await say({ result: { ok: false, reason: "addon_failed", fix: "the probe was given AAMIO_TEST_PASSTHRU, which only a call may get" } });
  } else {
    await say({ result: { ok: PROBE_OK, name: PROBE_NAME, version: PROBE_VERSION, aamio_addon: 2 } });
  }
  process.exit(0);
}
const short = request.name.split("_").pop();
if (short === "sleep") await wait(30000);
if (short === "crash") process.exit(3);
if (short === "garbage") {
  await new Promise((resolve) => process.stdout.write("not json\\n", resolve));
  process.exit(0);
}
if (short === "marked") {
  // A whole answer with a byte order mark in front of it.
  await new Promise((resolve) => process.stdout.write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ result: { status: "ok" } }))]), resolve));
  process.exit(0);
}
if (short === "bytes") {
  await say({ raw: Buffer.from("raw\\n").toString("base64") });
  process.exit(0);
}
if (short === "badbytes") {
  await say({ raw: "not base64!" });
  process.exit(0);
}
if (short === "fail") {
  await say({ result: { status: "no", fix: "x" }, exit_code: 3, is_error: true, stderr: "a note from the add-on" });
  process.exit(3);
}
if (short === "flood") {
  await fill(process.stdout, "x", 5000);
  await wait(5000);
  process.exit(0);
}
if (short === "noisy") {
  await fill(process.stderr, "y", 5000);
  await wait(5000);
  process.exit(0);
}
if (short === "spill") {
  await fill(process.stdout, "x", 5000);
  process.exit(0);
}
if (short === "grumble") {
  await fill(process.stderr, "y", 5000);
  await say({ result: { pong: true } });
  process.exit(0);
}
if (short === "mutter") {
  await fill(process.stderr, "y", 500);
  await say({ result: { pong: true } });
  process.exit(0);
}
if (short === "orphan") {
  // A process of its own that keeps this one's pipes after it is stopped.
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { stdio: "inherit" });
  await wait(30000);
}
await say({ result: {
  pong: true, kind: request.kind, name: request.name, arguments: request.arguments, subject: request.subject, own_key: request.own_key, state_dir: request.state_dir,
  deadline_seconds: request.deadline_seconds, aamio: request.aamio, home_env: process.env.AAMIO_HOME ?? null, addons_env: process.env.AAMIO_ADDONS ?? null,
  addon_env: process.env.AAMIO_ADDON ?? null, secret: process.env.AAMIO_TEST_SECRET ?? null, passthru: process.env.AAMIO_TEST_PASSTHRU ?? null,
} });
`;

const TOOL = { type: "object", properties: {}, additionalProperties: false };

/** The manifest of the test add-on: one command for each thing its process can do. */
export function manifestFor(name, { deadline = 2, hosts = true, environment = null, version = "0.0.2" } = {}) {
  const data = {
    aamio_addon: 2,
    name,
    version,
    process: { node: "process.js" },
    deadline_seconds: deadline,
    description: "A test add-on.",
    commands: {
      ping: { help: "answers pong", arguments: [{ name: "--word", help: "a word to carry" }] },
      check: { help: "a website and a partner", arguments: [{ name: "site", help: "the website", host: true }, { name: "--partner", help: "a name in the address book", required: true, subject: "partner" }] },
      file: { help: "the runtime's own key", needs: ["own_key"] },
      local: { help: "no home needed", runtime: false, arguments: [{ name: "path" }] },
      sleep: { help: "never answers" },
      crash: { help: "dies" },
      garbage: { help: "talks nonsense" },
      bytes: { help: "raw bytes" },
      badbytes: { help: "raw bytes that are not base64" },
      fail: { help: "a refusal" },
      flood: { help: "writes without end" },
      noisy: { help: "complains without end" },
      spill: { help: "a big answer, at once" },
      grumble: { help: "too much on standard error, at once" },
      mutter: { help: "exactly the limit on standard error" },
      orphan: { help: "leaves its pipes with a process of its own" },
    },
    tools: [
      { name: `aamio_addon_${name}_ping`, description: "answers pong", inputSchema: { type: "object", properties: { word: { type: "string" } }, additionalProperties: false } },
      {
        name: `aamio_addon_${name}_check`, description: "a website and a subject",
        inputSchema: { type: "object", properties: { site: { type: "string" }, partner: { type: "string" }, message: { type: "string" } }, required: ["site"], additionalProperties: false },
        host: "site", subject: { partner: "partner", message: "message" }, needs: ["own_key"],
      },
      { name: `aamio_addon_${name}_sleep`, description: "never answers", inputSchema: TOOL },
      { name: `aamio_addon_${name}_bytes`, description: "raw bytes", inputSchema: TOOL },
    ],
  };
  if (environment !== null) data.environment = environment;
  if (hosts) {
    data.hosts = { legacy_file: "old-hosts.json" };
  } else {
    delete data.commands.check;
    data.tools = data.tools.filter((tool) => !tool.name.endsWith("_check"));
  }
  return data;
}

/**
 * One add-on installed in a home. manifest null writes no manifest file, a
 * string is written as it is, and anything else as JSON. The answer names the
 * package's folder and the file its process leaves a line in each time it runs.
 */
export async function install(home, {
  distribution = "demo2-pkg", name = "demo2", version = "0.0.2", manifest = undefined, declared = "./aamio-addon.json", script = PROCESS, probe = {}, entry = "process.js", listed = true,
} = {}) {
  const root = join(home, "addon-packages", "npm");
  const dir = join(root, "node_modules", ...distribution.split("/"));
  await mkdir(dir, { recursive: true });
  let top = { private: true, dependencies: {} };
  try {
    top = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    // The first add-on of this home.
  }
  if (listed) top.dependencies = { ...top.dependencies, [distribution]: version };
  await writeFile(join(root, "package.json"), JSON.stringify(top, null, 2));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: distribution, version, type: "module", ...(declared === null ? {} : { aamioAddon: declared }) }, null, 2));
  const data = manifest === undefined ? manifestFor(name, { version }) : manifest;
  if (data !== null) await writeFile(join(dir, "aamio-addon.json"), typeof data === "string" ? data : JSON.stringify(data));
  if (script !== null) {
    const source = script
      .replace("PROBE_OK", JSON.stringify(probe.ok ?? true))
      .replace("PROBE_NAME", JSON.stringify(probe.name ?? name))
      .replace("PROBE_VERSION", JSON.stringify(probe.version ?? version));
    await writeFile(join(dir, entry), source);
  }
  return { dir, ran: join(dir, "process.ran") };
}

/** The lines the add-on's process has left, one for each time it ran: probe probe, command ping. */
export async function ran(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
