import { createServer } from "node:http";

const blockHash = `0x${"88".repeat(32)}`;
const blockTimestamp = "0x65a00000";
const blockNumber = "0x20000000000001";
const maximumRequestBytes = 32 * 1024;
const tokenAddress = "0x2222222222222222222222222222222222222222";
const canonicalBlockReference = Object.freeze({ blockHash, requireCanonical: true });

const uint256Result = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;

const textResult = (value) => {
  const bytes = Buffer.from(value, "utf8");
  const padding = Buffer.alloc((32 - (bytes.length % 32)) % 32);
  return `0x${[
    Buffer.from(uint256Result(32).slice(2), "hex"),
    Buffer.from(uint256Result(bytes.length).slice(2), "hex"),
    bytes,
    padding,
  ].map((part) => part.toString("hex")).join("")}`;
};

const fakeToken = Object.freeze({
  chainId: "eip155:4663",
  address: tokenAddress,
  runtimeCode: "0x6001600055",
  totalSupplyRaw: "1000000",
  decimals: "18",
  name: "Integration Token",
  symbol: "INT",
});

const callResults = Object.freeze({
  "0x18160ddd": uint256Result(fakeToken.totalSupplyRaw),
  "0x06fdde03": textResult(fakeToken.name),
  "0x95d89b41": textResult(fakeToken.symbol),
  "0x313ce567": uint256Result(fakeToken.decimals),
});

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

const exactBlockReference = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === "blockHash\0requireCanonical" &&
  value.blockHash === canonicalBlockReference.blockHash &&
  value.requireCanonical === true;

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
  if (
    method === "eth_getCode" &&
    params.length === 2 &&
    params[0] === fakeToken.address &&
    exactBlockReference(params[1])
  ) return fakeToken.runtimeCode;
  if (
    method === "eth_call" &&
    params.length === 2 &&
    exactBlockReference(params[1]) &&
    typeof params[0] === "object" &&
    params[0] !== null &&
    !Array.isArray(params[0]) &&
    Object.keys(params[0]).sort().join("\0") === "data\0to" &&
    params[0].to === fakeToken.address &&
    typeof params[0].data === "string" &&
    Object.hasOwn(callResults, params[0].data)
  ) return callResults[params[0].data];
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
    token: fakeToken,
    canonicalBlockReference,
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
