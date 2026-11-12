import { readFileSync } from "node:fs";

/*
 * What the add-on is called and which version it is, read from the manifest
 * beside the package's own files: aamio-addon.json is what aamio reads before
 * anything of the add-on runs, and the probe has to answer with the same name
 * and version, so there is one place that says them.
 */
const manifest = JSON.parse(readFileSync(new URL("../aamio-addon.json", import.meta.url), "utf8"));

// The short name: the command is aamio addon earshot, the tools aamio_addon_earshot_*.
export const NAME = manifest.name;
export const VERSION = manifest.version;
export const CONTRACT = manifest.aamio_addon;
