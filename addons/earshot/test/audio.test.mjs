// The speaker and the microphone, with programs that are not there: which program is asked for on which system, in
// which order, and what the answer says when none can. Nothing here plays a sound or opens a microphone: the one
// program really started is this Node, to see how a run ends. The same checks as the audio tests of aamio-php's
// addons/earshot/tests/process.inc.php.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as audio from "../src/audio.js";

const caught = async (act) => {
  try {
    await act();
  } catch (error) {
    return error;
  }
  return null;
};

// Only these programs are on the machine, and every one that is started is kept.
function machine(...names) {
  const ran = [];
  return {
    ran,
    find: (name) => (names.includes(name) ? "/usr/bin/" + name : null),
    start: async (command, seconds, program) => {
      ran.push([command, seconds, program]);
      return null;
    },
  };
}

test("a player is the first the system has", async () => {
  let m = machine("aplay", "ffplay");
  assert.equal(await audio.play("/tmp/card.wav", { find: m.find, start: m.start, system: "linux" }), "aplay");
  assert.deepEqual(m.ran, [[["aplay", "-q", "/tmp/card.wav"], 60, "/usr/bin/aplay"]], "started by its full path, and given a minute");
  assert.deepEqual(audio.players("/tmp/card.wav", "linux").map((command) => command[0]), ["paplay", "pw-play", "aplay", "ffplay"]);
  m = machine("afplay");
  assert.equal(await audio.play("/tmp/card.wav", { find: m.find, start: m.start, system: "darwin" }), "afplay");
  assert.deepEqual(m.ran[0][0], ["afplay", "/tmp/card.wav"]);
  m = machine("powershell");
  assert.equal(await audio.play("C:\\Temp\\it's.wav", { find: m.find, start: m.start, system: "win32" }), "powershell");
  assert.deepEqual(m.ran[0][0], ["powershell", "-NoProfile", "-NonInteractive", "-Command", "(New-Object Media.SoundPlayer 'C:\\Temp\\it''s.wav').PlaySync()"], "PowerShell's sound player on Windows, with the path quoted");
  assert.equal(audio.players("C:\\Temp\\\u2019x\u2018.wav", "win32")[0][4], "(New-Object Media.SoundPlayer 'C:\\Temp\\\u2019\u2019x\u2018\u2018.wav').PlaySync()", "and the quotes PowerShell also reads as quotes");
});

test("no player, and a player that fails, say so", async () => {
  let m = machine();
  let error = await caught(() => audio.play("/tmp/card.wav", { find: m.find, start: m.start, system: "linux" }));
  assert.ok(error instanceof audio.Unavailable && error.reason === "no_player");
  assert.equal(error.fix, "Nothing on this machine plays a sound file: install pulseaudio-utils (paplay), alsa-utils (aplay) or ffmpeg, or write the sound to a file with --out (out over MCP) and play it another way.");
  m = machine("aplay");
  error = await caught(() => audio.play("/tmp/card.wav", { find: m.find, start: async () => "aplay stopped with code 1: Device or resource busy", system: "linux" }));
  assert.ok(error instanceof audio.Unavailable && error.reason === "player_failed");
  assert.equal(error.fix, "The sound could not be played: aplay stopped with code 1: Device or resource busy. Check the speaker and the volume, or write the sound to a file with --out (out over MCP) and play it another way.");
  // The next one is tried when one fails, and the first that plays is the one named.
  m = machine("paplay", "aplay");
  const tried = [];
  const player = await audio.play("/tmp/card.wav", { find: m.find, start: async (command) => (tried.push(command[0]), command[0] === "paplay" ? "paplay stopped with code 1: Connection refused" : null), system: "linux" });
  assert.deepEqual([player, tried], ["aplay", ["paplay", "aplay"]]);
});

test("a recording is mono 16-bit PCM at 48 kHz, by the first recorder the system has", async () => {
  let m = machine("arecord");
  assert.equal(await audio.record(7, "/tmp/heard.wav", { find: m.find, start: m.start, system: "linux" }), "arecord");
  assert.deepEqual(m.ran, [[["arecord", "-q", "-f", "S16_LE", "-r", "48000", "-c", "1", "-d", "7", "/tmp/heard.wav"], 22, "/usr/bin/arecord"]], "given its seconds and fifteen more");
  assert.deepEqual(audio.recorders(7, "x.wav", "linux").map((command) => command[0]), ["arecord", "rec", "ffmpeg"]);
  assert.deepEqual(audio.recorders(7, "x.wav", "darwin").map((command) => command[0]), ["rec", "ffmpeg"]);
  assert.deepEqual(audio.recorders(7, "x.wav", "win32"), [["sox", "-q", "-t", "waveaudio", "default", "-c", "1", "-r", "48000", "-b", "16", "x.wav", "trim", "0", "7"]], "sox reads the default device on Windows");
  assert.deepEqual(audio.recorders(7, "x.wav", "linux")[1], ["rec", "-q", "-c", "1", "-r", "48000", "-b", "16", "x.wav", "trim", "0", "7"]);
  m = machine("rec");
  assert.equal(await audio.record(5, "/tmp/heard.wav", { find: m.find, start: m.start, system: "darwin" }), "rec");
});

test("without a recorder the answer says what to install, or to read a file", async () => {
  const m = machine();
  let error = await caught(() => audio.record(7, "/tmp/heard.wav", { find: m.find, start: m.start, system: "linux" }));
  assert.ok(error instanceof audio.Unavailable && error.reason === "no_recorder");
  assert.equal(error.fix, "Nothing on this machine records from the microphone. Install sox, or alsa-utils (arecord) or ffmpeg on Linux, or record the sound another way and read the file with aamio addon earshot decode FILE (aamio_addon_earshot_decode).");
  error = await caught(() => audio.record(7, "C:\\Temp\\heard.wav", { find: m.find, start: m.start, system: "win32" }));
  assert.ok(error.fix.startsWith("Nothing on this machine records from the microphone. On Windows, SoX comes with winget install ChrisBagwell.SoX, and is found once the terminal is started again, or record the sound another way"));
  const sox = machine("sox");
  error = await caught(() => audio.record(7, "C:\\Temp\\heard.wav", { find: sox.find, start: async () => "sox stopped with code 2: no default audio device configured", system: "win32" }));
  assert.ok(error instanceof audio.Unavailable && error.reason === "recorder_failed");
  assert.equal(error.fix, "Nothing was recorded: sox stopped with code 2: no default audio device configured. Check that a microphone is connected and that this app may use it: macOS asks once for the app the agent runs in, Windows has it under the privacy settings for desktop apps.");
});

test("a program is found on PATH by its full path, and a batch file is not one", async (t) => {
  const place = await mkdtemp(join(tmpdir(), "aamio-earshot-test-"));
  t.after(() => rm(place, { recursive: true, force: true }));
  const node = basename(process.execPath);
  assert.equal(audio.which(node.replace(/\.exe$/i, ""), { env: { PATH: [place, dirname(process.execPath)].join(process.platform === "win32" ? ";" : ":") } }), process.execPath);
  assert.equal(audio.which("surely-no-such-program-here"), null);
  assert.equal(audio.which("anything", { env: {} }), null);
  // As Windows names programs, whatever system this runs on.
  await writeFile(join(place, "tool.cmd"), "@echo off\r\n");
  await writeFile(join(place, "only.cmd"), "@echo off\r\n");
  await writeFile(join(place, "tool.exe"), "MZ");
  assert.equal(audio.which("tool", { env: { Path: `;"${place}"` }, windows: true }), join(place, "tool.exe"), "the name of the variable in any case, and a folder in quotes");
  assert.equal(audio.which("tool.exe", { env: { PATH: place }, windows: true }), join(place, "tool.exe"));
  assert.equal(audio.which("only", { env: { PATH: place }, windows: true }), null, "a batch file needs a shell, and nothing here is started through one");
  assert.equal(audio.which("only.cmd", { env: { PATH: place }, windows: true }), null);
  if (process.platform !== "win32") {
    await writeFile(join(place, "plain"), "#!/bin/sh\n");
    assert.equal(audio.which("plain", { env: { PATH: place } }), null, "a file nobody may run is no program");
    await chmod(join(place, "plain"), 0o755);
    assert.equal(audio.which("plain", { env: { PATH: place } }), join(place, "plain"));
  }
});

test("a program is found by its full path, never in the working directory however PATH names it", async (t) => {
  // A sox.exe in the working directory ran in place of the installed one, and a PATH that began with . gave back
  // sox.exe, a name relative to wherever the agent was (a security review of 13 November 2026, a review of 14 November).
  const root = await mkdtemp(join(tmpdir(), "aamio-earshot-where-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "Program Files", "sox");
  const name = process.platform === "win32" ? "sox.exe" : "sox";
  for (const folder of [installed, join(root, "work-a"), join(root, "work b")]) {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, name), process.platform === "win32" ? "MZ" : "#!/bin/sh\n");
    await chmod(join(folder, name), 0o755);
  }
  const separator = process.platform === "win32" ? ";" : ":";
  for (const work of [join(root, "work-a"), join(root, "work b")]) {
    for (const path of [[".", installed], ["", installed], [work, installed], [work + (process.platform === "win32" ? "\\" : "/"), installed], ["sox", installed]]) {
      assert.equal(audio.which("sox", { env: { PATH: path.join(separator) }, cwd: work }), join(installed, name), `${path.join(separator)} from ${work}`);
    }
    assert.equal(audio.which("sox", { env: { PATH: [".", work].join(separator) }, cwd: work }), null, "nothing found is null, never the one in the working directory");
  }
  // As Windows names them, with files that are not there.
  const files = new Set(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "C:\\work\\powershell.exe", "C:\\Tools\\sox.exe", "C:\\work\\sox.exe"]);
  const isProgram = (path) => files.has(path.replace(/\//g, "\\"));
  assert.equal(audio.which("powershell", { env: { PATH: "C:\\work", SystemRoot: "C:\\Windows" }, windows: true, hostWindows: true, cwd: "C:\\work", isProgram }), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell from the folder Windows keeps it in");
  assert.equal(audio.which("sox", { env: { PATH: "C:sox;\\sox;C:\\work;C:\\Tools" }, windows: true, hostWindows: true, cwd: "C:\\work", isProgram }).replace(/\//g, "\\"), "C:\\Tools\\sox.exe", "C:folder and \\folder are not full paths");
});

test("what starts is the full path the lookup gave", async () => {
  const started = [];
  const start = async (command, seconds, program) => {
    started.push([program, ...command.slice(1)]);
    return null;
  };
  assert.equal(await audio.record(3, "C:\\heard.wav", { find: (name) => (name === "sox" ? "C:\\Program Files\\sox\\sox.exe" : null), start, system: "win32" }), "sox");
  assert.equal(started[0][0], "C:\\Program Files\\sox\\sox.exe");
  assert.deepEqual(started[0].slice(1, 5), ["-q", "-t", "waveaudio", "default"]);
  const none = await caught(() => audio.record(3, "C:\\heard.wav", { find: () => null, start, system: "win32" }));
  assert.ok(none instanceof audio.Unavailable && none.reason === "no_recorder" && none.fix.includes("winget install ChrisBagwell.SoX"));
  assert.equal(started.length, 1, "a program that is not there starts nothing");
});

test("a program is run to its end, within its time, and says how it went", async () => {
  const node = (script) => ["node", "-e", script];
  assert.equal(await audio.run(node("process.exit(0)"), 20, process.execPath), null);
  assert.equal(await audio.run(node("console.error('first line'); console.error('  the last line  '); process.exit(3)"), 20, process.execPath), "node stopped with code 3: the last line");
  assert.equal(await audio.run(node("process.exit(4)"), 20, process.execPath), "node stopped with code 4: no reason given");
  const started = Date.now();
  assert.equal(await audio.run(node("setTimeout(() => {}, 20000)"), 0.3, process.execPath), "node did not finish within 0.3 seconds");
  assert.ok(Date.now() - started < 5000, "and is not waited for");
  assert.match(await audio.run(["nothing-here"], 5, join(tmpdir(), "aamio-earshot-no-such-program")), /^nothing-here could not be started: /);
  assert.equal(audio.platform(), process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
});
