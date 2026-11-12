// The process aamio runs for each call of this add-on, named in
// aamio-addon.json under process.node: one request on standard input, one
// answer on standard output, as contract 2 of aamio's add-ons says. It needs
// nothing of the core and loads only its own files.
import { main } from "./src/process.js";

try {
  // The exit code is the answer's, and the process ends by itself once the
  // answer is written: an exit straight after a write to a pipe can cut it.
  process.exitCode = await main();
} catch (failure) {
  // A fault in the add-on: one line for whoever reads standard error, and no answer.
  process.stderr.write(`aamio-earshot: ${failure?.name ?? "Error"}: ${failure?.message ?? failure}\n`);
  process.exitCode = 1;
}
