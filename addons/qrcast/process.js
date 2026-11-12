// The process aamio runs for each call of this add-on, named in
// aamio-addon.json under process.node: one request on standard input, one
// answer on standard output, as contract 2 of aamio's add-ons says. It needs
// nothing of the core and loads only its own files.
//
//     node process.js < request.json
//
// The process ends with the answer's exit code once the answer is written: a
// viewer it opened and a connection it made are not waited for.
import { main } from "./src/process.js";

process.exit(await main());
