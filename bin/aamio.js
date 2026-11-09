#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { initIdentity, readIdentity } from "../src/node-identity.js";
import { serveMcp } from "../src/node-mcp.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const help = `Usage: aamio [--home DIR] <command>

  init       Create a local identity, or show the existing public identity
  whoami     Show the public key, hash and hash prefix
  serve      Start the local MCP server on standard input and output

The default home is AAMIO_HOME or ~/.aamio. A new home needs an existing
parent directory. Run with --version to print the npm package version.
`;

function parse(argv) {
  let home;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--home" || arg.startsWith("--home=")) {
      const value = arg === "--home" ? argv[++i] : arg.slice("--home=".length);
      if (home !== undefined || !value || (arg === "--home" && value.startsWith("-"))) {
        throw new Error("Supply --home once with a directory path.");
      }
      home = value;
    } else {
      args.push(arg);
    }
  }
  if (args.length === 0 || (args.length === 1 && ["-h", "--help", "help"].includes(args[0]))) {
    return { command: "help" };
  }
  if (args.length === 1 && args[0] === "--version") return { command: "version" };
  if (args.length !== 1 || !["init", "whoami", "serve"].includes(args[0])) {
    throw new Error("Expected init, whoami or serve. Run aamio --help for usage.");
  }
  return { command: args[0], home: resolve(home ?? (process.env.AAMIO_HOME || join(homedir(), ".aamio"))) };
}

async function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(error.message + "\n");
    return 2;
  }
  const { command, home } = options;
  if (command === "help") process.stdout.write(help);
  else if (command === "version") process.stdout.write(version + "\n");
  else if (command === "serve") {
    await initIdentity(home);
    await serveMcp({ home, version });
  } else {
    const identity = command === "init" ? await initIdentity(home) : await readIdentity(home);
    process.stdout.write(JSON.stringify(identity) + "\n");
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  const known = ["home_not_initialized", "key_unreadable", "home_init_failed"];
  process.stderr.write((known.includes(error?.code) ? error.message : "The local Node runtime could not complete this command.") + "\n");
  process.exitCode = 1;
}
