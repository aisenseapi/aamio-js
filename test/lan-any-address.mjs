// A machine with a route out, put into a transport's process for the test of where the lan transport says it is reached
// when it listens on 0.0.0.0. Loaded with --import before transport.js, it binds what asks for 0.0.0.0 to 127.0.0.1
// instead, so nothing listens beyond this machine, and answers a UDP connect, which only picks the interface a route
// would take, with the address in AAMIO_TEST_ROUTE. node --test runs every module under test/ as a test file; run that
// way, without the variable, there is nothing to do.

import dgram from "node:dgram";

const route = process.env.AAMIO_TEST_ROUTE ?? "";

if (route) {
  const bind = dgram.Socket.prototype.bind;
  dgram.Socket.prototype.bind = function (options, ...rest) {
    if (options && typeof options === "object" && options.address === "0.0.0.0") return bind.call(this, { ...options, address: "127.0.0.1" }, ...rest);
    return bind.call(this, options, ...rest);
  };
  const routed = new WeakSet();
  const address = dgram.Socket.prototype.address;
  dgram.Socket.prototype.connect = function (port, host, callback) {
    routed.add(this);
    setImmediate(() => callback?.());
    return undefined;
  };
  dgram.Socket.prototype.address = function () {
    if (routed.has(this)) return { address: route, family: "IPv4", port: 0 };
    return address.call(this);
  };
}
