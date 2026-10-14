// Test-only external transport setup. Production backend/bootstrap/SDK worker
// entries execute unchanged; only their relay endpoint and egress are isolated.
import net from "node:net";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, watch, writeFileSync } from "node:fs";

const relayPort = Number(process.env.LITTLEJOHN_MCP_TEST_RELAY_PORT);
if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) throw new Error("Prepared relay is required.");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0]; const options = Array.isArray(first) ? first[0] : first;
  const target = typeof options === "object" && options !== null ? options : { port: options, host: args[1] };
  if (![46630, relayPort].includes(Number(target.port)) || !["127.0.0.1", "::1"].includes(target.host ?? target.hostname)) {
    throw new Error("Backend qualification forbids external socket egress.");
  }
  return Reflect.apply(connect, this, args);
};
globalThis.fetch = async () => { throw new Error("Backend qualification forbids external fetch."); };
const fork = childProcess.fork;
childProcess.fork = function (entry, args, options) {
  if (basename(String(entry)) !== "sdk-worker-entry.js") throw new Error("Unexpected backend child entry.");
  const child = fork(entry, args, { ...options,
    execArgv: ["--import", fileURLToPath(new URL("../wallet/worker-egress.mjs", import.meta.url))],
    env: { ...options.env, LITTLEJOHN_MCP_TEST_RELAY_PORT: String(relayPort) } });
  const send = child.send;
  child.send = function (message, ...rest) {
    const value = typeof message === "string" ? JSON.parse(message) : message;
    // relayUrl is the existing strict loopback-only bootstrap input. No domain
    // command, observed state, response, correlation or settlement is replaced.
    const next = value?.kind === "bootstrap" ? JSON.stringify({ ...value, relayUrl: `ws://127.0.0.1:${relayPort}/` }) : message;
    return Reflect.apply(send, this, [next, ...rest]);
  };
  return child;
};
syncBuiltinESMExports();

const gate = process.env.LITTLEJOHN_MCP_TEST_BACKEND_GATE;
if (gate) {
  writeFileSync(`${gate}.waiting-${process.pid}`, "waiting");
  await new Promise((resolve, reject) => {
    let watcher;
    const inspect = () => { if (existsSync(gate)) { watcher?.close(); resolve(); } };
    watcher = watch(dirname(gate), inspect);
    watcher.on("error", reject);
    inspect();
  });
}
