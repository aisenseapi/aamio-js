// The process the core runs for each call of this add-on: one request on
// standard input, one answer on standard output.
//
//     node process.js < request.json
//
// Standard output carries the answer and nothing else. The process ends when
// the answer is written, with the answer's exit code: a lookup that never
// came back cannot keep it alive.
import { handle } from "./src/handle.js";

let text = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) text += chunk;
let request = null;
try {
  request = JSON.parse(text);
} catch {
  // Not a request: said in the answer.
}
const said = await handle(request);
process.stdout.write(JSON.stringify(said), () => process.exit(said.exit_code));
