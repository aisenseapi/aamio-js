// A send that fails, put into a transport's process for the test of what the lan transport answers then. Loaded with
// --import before transport.js, it makes every datagram to a port named in AAMIO_TEST_SEND_FAILS call back with ENOBUFS,
// as a full buffer of the operating system does, without sending it, and lets every other datagram through. node --test
// runs every module under test/ as a test file; run that way, without the variable, there is nothing to do.

import dgram from "node:dgram";

const failing = new Set((process.env.AAMIO_TEST_SEND_FAILS ?? "").split(",").filter(Boolean).map(Number));

if (failing.size) {
  const send = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (message, port, address, callback) {
    if (!failing.has(port)) return send.call(this, message, port, address, callback);
    setImmediate(callback, Object.assign(new Error("send ENOBUFS"), { code: "ENOBUFS", syscall: "send" }));
    return undefined;
  };
}
