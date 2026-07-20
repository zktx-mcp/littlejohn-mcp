import { createServer } from "node:http";

const blockHash = `0x${"88".repeat(32)}`;
const blockTimestamp = "0x65a00000";
const blockNumber = "0x20000000000001";
const maximumRequestBytes = 32 * 1024;
const walletAddress = "0x1111111111111111111111111111111111111111";
const alternateWalletAddress = "0x3333333333333333333333333333333333333333";
const walletAddresses = Object.freeze([walletAddress, alternateWalletAddress]);
const nativeBalanceRaw = "4200000000000000000";
const tokenAddresses = Object.freeze(Array.from({ length: 6 }, (_, index) =>
  `0x${(0x22 + index).toString(16).repeat(20)}`));
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

const fakeTokens = Object.freeze(tokenAddresses.map((address) => Object.freeze({
  chainId: "eip155:4663",
  address,
  runtimeCode: "0x6001600055",
  totalSupplyRaw: "1000000",
  accountBalanceRaw: "2500000000000000000",
  decimals: "18",
  name: "Integration Token",
  symbol: "INT",
})));
const fakeToken = fakeTokens[0];
if (fakeToken === undefined) throw new TypeError("Fake token authority is unavailable.");

const balanceOfCalls = new Set(walletAddresses.map(
  (address) => `0x70a08231${address.slice(2).padStart(64, "0")}`,
));

const callResult = (token, data) => {
  if (balanceOfCalls.has(data)) return uint256Result(token.accountBalanceRaw);
  if (data === "0x18160ddd") return uint256Result(token.totalSupplyRaw);
  if (data === "0x06fdde03") return textResult(token.name);
  if (data === "0x95d89b41") return textResult(token.symbol);
  if (data === "0x313ce567") return uint256Result(token.decimals);
  return undefined;
};

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
  const token = typeof params[0] === "object" && params[0] !== null
    ? fakeTokens.find((candidate) => candidate.address === params[0].to)
    : fakeTokens.find((candidate) => candidate.address === params[0]);
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
    token !== undefined &&
    exactBlockReference(params[1])
  ) return token.runtimeCode;
  if (
    method === "eth_getBalance" &&
    params.length === 2 &&
    walletAddresses.includes(params[0]) &&
    exactBlockReference(params[1])
  ) return `0x${BigInt(nativeBalanceRaw).toString(16)}`;
  if (
    method === "eth_call" &&
    params.length === 2 &&
    exactBlockReference(params[1]) &&
    typeof params[0] === "object" &&
    params[0] !== null &&
    !Array.isArray(params[0]) &&
    Object.keys(params[0]).sort().join("\0") === "data\0to" &&
    token !== undefined &&
    typeof params[0].data === "string" &&
    callResult(token, params[0].data) !== undefined
  ) return callResult(token, params[0].data);
  throw new TypeError(`Unexpected automated RPC method: ${method}`);
};

/** @type {typeof import("./fake-rpc.d.mts").startFakeRpc} */
export const startFakeRpc = async () => {
  const calls = [];
  const unexpectedMethods = [];
  let unavailable = false;
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
        if (unavailable) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32005, message: "Fake RPC is unavailable." },
          }));
          return;
        }
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
    nativeBalanceRaw,
    token: fakeToken,
    tokens: fakeTokens,
    canonicalBlockReference,
    calls,
    assertNoUnexpectedMethods() {
      if (unexpectedMethods.length !== 0) {
        throw new TypeError(`Automated integration requested prohibited RPC methods: ${unexpectedMethods.join(", ")}`);
      }
    },
    setUnavailable(value) {
      unavailable = value === true;
    },
    close: () => /** @type {Promise<void>} */ (new Promise((resolveClose, rejectClose) => {
      server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
      server.closeAllConnections();
    })),
  });
};
