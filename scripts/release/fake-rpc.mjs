import { createServer } from "node:http";

import {
  stockFactoryImplementationAddress,
  stockFactoryImplementationCodeFixture,
  stockFactoryImplementationSlot,
  stockFactoryProxyAddress,
  stockFactoryProxyCodeFixture,
} from "./stock-factory-fixture.mjs";

const blockHash = `0x${"88".repeat(32)}`;
const blockTimestamp = "0x65a00000";
const blockNumber = "0x20000000000001";
const maximumRequestBytes = 32 * 1024;
const walletAddress = "0x1111111111111111111111111111111111111111";
const alternateWalletAddress = "0x3333333333333333333333333333333333333333";
const walletAddresses = Object.freeze([walletAddress, alternateWalletAddress]);
const nativeBalanceRaw = "4200000000000000000";
const officialTokens = Object.freeze([
  {
    assetUid: "0x00000000000000000000000000000000c2425be3658540dd8e2424cbf3c5c649",
    address: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
    name: "Apple",
    symbol: "AAPL",
  },
  {
    assetUid: "0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5",
    address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    name: "NVIDIA",
    symbol: "NVDA",
  },
  {
    assetUid: "0x00000000000000000000000000000000cfece3244ea34bb29414dd9488b32d9f",
    address: "0x322f0929c4625ed5bad873c95208d54e1c003b2d",
    name: "Tesla",
    symbol: "TSLA",
  },
  {
    assetUid: "0x0000000000000000000000000000000053b69e2076884cc9ae2ada9bc7095df3",
    address: "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3",
    name: "Alphabet",
    symbol: "GOOGL",
  },
  {
    assetUid: "0x000000000000000000000000000000001c6f27a62789417d8ed359ed3c2d3da1",
    address: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c",
    name: "SPDR S&P 500 ETF Trust",
    symbol: "SPY",
  },
  {
    assetUid: `0x${"99".repeat(32)}`,
    address: `0x${"27".repeat(20)}`,
    name: "Official Candidate",
    symbol: "OFF",
  },
]);
const customTokenAddress = `0x${"28".repeat(20)}`;
const tokenAddresses = Object.freeze([
  ...officialTokens.map((token) => token.address),
  customTokenAddress,
]);
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

const fakeTokens = Object.freeze(tokenAddresses.map((address) => {
  const official = officialTokens.find((token) => token.address === address);
  return Object.freeze({
  chainId: "eip155:4663",
  address,
  runtimeCode: "0x6001600055",
  totalSupplyRaw: "1000000",
  accountBalanceRaw: "2500000000000000000",
  decimals: "18",
  name: official?.name ?? "Custom Integration Token",
  symbol: official?.symbol ?? "CSTM",
  currentMultiplier: "2000000000000000000",
  pendingMultiplier: "3000000000000000000",
  pendingEffectiveAt: "2000000000",
  ...(official === undefined ? {} : { assetUid: official.assetUid }),
  });
}));
const fakeToken = fakeTokens.find((token) => token.address === customTokenAddress);
const fakeOfficialCandidate = fakeTokens.find(
  (token) => token.address === officialTokens.at(-1)?.address,
);
const fakeOfficialCandidateUid = officialTokens.at(-1)?.assetUid;
if (fakeToken === undefined) throw new TypeError("Fake token authority is unavailable.");
if (fakeOfficialCandidate === undefined || fakeOfficialCandidateUid === undefined) {
  throw new TypeError("Fake official candidate authority is unavailable.");
}
const verifiedFakeOfficialCandidate = Object.freeze({
  ...fakeOfficialCandidate,
  assetUid: fakeOfficialCandidateUid,
});

const balanceOfCalls = new Set(walletAddresses.map(
  (address) => `0x70a08231${address.slice(2).padStart(64, "0")}`,
));
const balanceOfUiCalls = new Set(walletAddresses.map(
  (address) => `0x437a9958${address.slice(2).padStart(64, "0")}`,
));
const boolResult = (value) => uint256Result(value ? 1 : 0);
const supportedInterfaceIds = new Set([
  "01ffc9a7",
  "a60bf13d",
  "4bd27648",
  "d890fd71",
]);

const callResult = (token, data) => {
  if (balanceOfCalls.has(data)) return uint256Result(token.accountBalanceRaw);
  if (balanceOfUiCalls.has(data)) {
    return uint256Result(
      BigInt(token.accountBalanceRaw) * BigInt(token.currentMultiplier) /
      1_000_000_000_000_000_000n,
    );
  }
  if (data === "0x18160ddd") return uint256Result(token.totalSupplyRaw);
  if (data === "0x06fdde03") return textResult(token.name);
  if (data === "0x95d89b41") return textResult(token.symbol);
  if (data === "0x313ce567") return uint256Result(token.decimals);
  if (data === "0xa60bf13d") return uint256Result(token.currentMultiplier);
  if (data === "0xdc767007") return uint256Result(token.pendingMultiplier);
  if (data === "0x97a4064f") return uint256Result(token.pendingEffectiveAt);
  if (/^0x01ffc9a7[0-9a-f]{64}$/u.test(data)) {
    const interfaceId = data.slice(10, 18);
    return boolResult(supportedInterfaceIds.has(interfaceId));
  }
  return undefined;
};

const officialAssetResponse = JSON.stringify({
  assets: officialTokens.map((token) => ({
    id: token.assetUid,
    status: "ASSET_STATUS_ACTIVE",
    deployments: [{ chainId: 4663, contractAddress: token.address }],
    tokenName: token.name,
    tokenSymbol: token.symbol,
  })),
});

const factoryMappedAddress = (data) => {
  if (!/^0x97bb3ce9[0-9a-f]{64}$/u.test(data)) return undefined;
  const uid = `0x${data.slice(10)}`;
  const token = officialTokens.find((candidate) => candidate.assetUid === uid);
  return token === undefined ? undefined : `0x${"0".repeat(24)}${token.address.slice(2)}`;
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
    exactBlockReference(params[1])
  ) {
    if (params[0] === stockFactoryProxyAddress) return stockFactoryProxyCodeFixture;
    if (params[0] === stockFactoryImplementationAddress) {
      return stockFactoryImplementationCodeFixture;
    }
    if (token !== undefined) return token.runtimeCode;
  }
  if (
    method === "eth_getStorageAt" &&
    params.length === 3 &&
    params[0] === stockFactoryProxyAddress &&
    params[1] === stockFactoryImplementationSlot &&
    exactBlockReference(params[2])
  ) return `0x${"0".repeat(24)}${stockFactoryImplementationAddress.slice(2)}`;
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
    (Object.keys(params[0]).sort().join("\0") === "data\0to" ||
      (Object.keys(params[0]).sort().join("\0") === "data\0gas\0to" &&
        params[0].gas === "0x7530")) &&
    typeof params[0].data === "string" &&
    ((token !== undefined && callResult(token, params[0].data) !== undefined) ||
      (params[0].to === stockFactoryProxyAddress &&
        factoryMappedAddress(params[0].data) !== undefined))
  ) {
    return token !== undefined
      ? callResult(token, params[0].data)
      : factoryMappedAddress(params[0].data);
  }
  throw new TypeError(`Unexpected automated RPC method: ${method}`);
};

/** @type {typeof import("./fake-rpc.d.mts").startFakeRpc} */
export const startFakeRpc = async () => {
  const calls = [];
  const unexpectedMethods = [];
  const failures = [];
  let unavailable = false;
  let assetSourceUnavailable = false;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/rhj/assets") {
        if (assetSourceUnavailable) {
          response.writeHead(503).end();
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(officialAssetResponse),
        });
        response.end(officialAssetResponse);
        return;
      }
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
        failures.push(Object.freeze({
          method: typeof method === "string" ? method : null,
          params: Object.freeze([...(rpc?.params ?? [])]),
          message: error instanceof Error ? error.message : "Fake RPC rejected the request.",
        }));
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
    assetSourceUrl: `http://127.0.0.1:${address.port}/rhj/assets`,
    nativeBalanceRaw,
    token: fakeToken,
    defaultTokens: fakeTokens.slice(0, 5),
    officialCandidate: verifiedFakeOfficialCandidate,
    tokens: fakeTokens,
    canonicalBlockReference,
    calls,
    failures,
    assertNoUnexpectedMethods() {
      if (unexpectedMethods.length !== 0) {
        throw new TypeError(`Automated integration requested prohibited RPC methods: ${unexpectedMethods.join(", ")}`);
      }
    },
    setUnavailable(value) {
      unavailable = value === true;
    },
    setAssetSourceUnavailable(value) {
      assetSourceUnavailable = value === true;
    },
    close: () => /** @type {Promise<void>} */ (new Promise((resolveClose, rejectClose) => {
      server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
      server.closeAllConnections();
    })),
  });
};
