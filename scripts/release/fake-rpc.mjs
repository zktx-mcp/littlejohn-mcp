import { createServer } from "node:http";

const blockHash = `0x${"88".repeat(32)}`;
const blockTimestamp = "0x65a00000";
const blockNumber = "0x20000000000001";
const maximumRequestBytes = 32 * 1024;

const readBody = async (request) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maximumRequestBytes) throw new TypeError("Fake RPC request is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const parseRequest = (value) => {
  const parsed = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    parsed.jsonrpc !== "2.0" ||
    typeof parsed.id !== "string" ||
    typeof parsed.method !== "string" ||
    !Array.isArray(parsed.params)
  ) throw new TypeError("Fake RPC request is invalid.");
  return parsed;
};

const resultFor = (method, params) => {
  if (method === "eth_chainId" && params.length === 0) return "0x1237";
  if (
    method === "eth_getBlockByNumber" &&
    params.length === 2 &&
    params[0] === "latest" &&
    params[1] === false
  ) {
    return {
      number: blockNumber,
      hash: blockHash,
      timestamp: blockTimestamp,
      transactions: [],
    };
  }
  throw new TypeError(`Unexpected automated RPC method: ${method}`);
};

/** @type {typeof import("./fake-rpc.d.mts").startFakeRpc} */
export const startFakeRpc = async () => {
  const calls = [];
  const unexpectedMethods = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/") {
        response.writeHead(404).end();
        return;
      }
      let rpc;
      try {
        rpc = parseRequest(await readBody(request));
        calls.push(Object.freeze({ method: rpc.method, params: Object.freeze([...rpc.params]) }));
        const result = resultFor(rpc.method, rpc.params);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      } catch (error) {
        const method = rpc?.method;
        if (typeof method === "string") unexpectedMethods.push(method);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: rpc?.id ?? null,
          error: {
            code: -32601,
            message: error instanceof Error ? error.message : "Fake RPC rejected the request.",
          },
        }));
      }
    })();
  });
  await /** @type {Promise<void>} */ (new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  }));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new TypeError("Fake RPC did not bind a TCP address.");
  }
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}`,
    calls,
    assertNoUnexpectedMethods() {
      if (unexpectedMethods.length !== 0) {
        throw new TypeError(`Automated integration requested prohibited RPC methods: ${unexpectedMethods.join(", ")}`);
      }
    },
    close: () => /** @type {Promise<void>} */ (new Promise((resolveClose, rejectClose) => {
      server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
      server.closeAllConnections();
    })),
  });
};
