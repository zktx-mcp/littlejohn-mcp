import net from "node:net";

const port = Number(process.env["LITTLEJOHN_TEST_RELAY_PORT"]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The test relay is not prepared.");
globalThis.fetch = async () => { throw new Error("External fetch is disabled in this test."); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...arguments_) {
  const first = arguments_[0];
  const options = Array.isArray(first) ? first[0] : first;
  const target = typeof options === "object" && options !== null ? options : { port: options, host: arguments_[1] };
  if (Number(target.port) !== port || !["127.0.0.1", "::1"].includes(target.host ?? target.hostname)) {
    throw new Error("External sockets are disabled in this test.");
  }
  return Reflect.apply(connect, this, arguments_);
};
