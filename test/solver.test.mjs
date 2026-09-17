// A solver handed in from outside: asked first, believed only when its nonce
// holds. No network.

import test from "node:test";
import assert from "node:assert/strict";
import { setWorkSolver, solveWork, solveBoardWork, sha256hex, zeroBits, powDigest, boardPowDigest } from "../src/aamio.js";

const w = "b4netymg7r5nnt2yiscp";
const key = "A".repeat(43);
const body = '{"text":"hei"}';
const sha = sha256hex(body);

test("a solver that is handed in is asked, with the hash and not the body", () => {
  const own = solveWork(w, key, body, 10);
  const ownBoard = solveBoardWork(key, body, 10);
  const asked = [];
  setWorkSolver({
    thread: (...args) => (asked.push(["thread", ...args]), own),
    board: (...args) => (asked.push(["board", ...args]), ownBoard),
  });
  try {
    assert.equal(solveWork(w, key, body, 10), own);
    assert.equal(solveBoardWork(key, body, 10), ownBoard);
    assert.deepEqual(asked, [["thread", w, key, sha, 10], ["board", key, sha, 10]]);
  } finally {
    setWorkSolver(null);
  }
});

test("a nonce that does not hold is not believed, and the built-in loop takes over", () => {
  const own = solveWork(w, key, body, 10);
  try {
    setWorkSolver({ thread: () => "1", board: () => "not a nonce" });
    assert.equal(solveWork(w, key, body, 10), own);
    assert.ok(zeroBits(boardPowDigest(key, sha, solveBoardWork(key, body, 10))) >= 10);
    setWorkSolver({ thread: () => { throw new Error("broken"); } });
    assert.equal(solveWork(w, key, body, 10), own, "a solver that throws falls back too");
  } finally {
    setWorkSolver(null);
  }
});

test("an unsigned message hands the solver an empty key", () => {
  let seen = null;
  try {
    setWorkSolver({ thread: (_w, k) => ((seen = k), "0") });
    const nonce = solveWork(w, null, body, 8);
    assert.equal(seen, "");
    assert.ok(zeroBits(powDigest(w, null, sha, nonce)) >= 8);
  } finally {
    setWorkSolver(null);
  }
});

test("aamio-wasm, when it is built beside this checkout, finds the nonces this client finds", async (t) => {
  let wasm;
  try {
    wasm = await import(new URL("../../aamio-rust/wasm/pkg/index.js", import.meta.url).href);
  } catch {
    t.skip("aamio-wasm is not built beside this checkout");
    return;
  }
  const own = solveWork(w, key, body, 14);
  const ownBoard = solveBoardWork(key, body, 14);
  setWorkSolver({ thread: wasm.solvePow, board: wasm.solveBoardPow });
  try {
    assert.equal(solveWork(w, key, body, 14), own);
    assert.equal(solveBoardWork(key, body, 14), ownBoard);
  } finally {
    setWorkSolver(null);
  }
});
