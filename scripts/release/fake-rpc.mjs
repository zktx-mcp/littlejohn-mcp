import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:https";

import {
  stockFactoryImplementationAddress,
  stockFactoryImplementationCodeFixture,
  stockFactoryImplementationSlot,
  stockFactoryProxyAddress,
  stockFactoryProxyCodeFixture,
} from "./stock-factory-fixture.mjs";
import {
  uniswapV2FactoryRuntimeCodeFixture,
} from "./uniswap-v2-factory-fixture.mjs";

const blockHash = `0x${"88".repeat(32)}`;
const blockTimestamp = "0x6a7f5fbc";
const blockNumber = "0x20000000000001";
const maximumRequestBytes = 32 * 1024;
const caCertificatePath = realpathSync(
  new URL("./fixtures/rpc-loopback-ca.pem", import.meta.url),
);
const serverCertificatePath = realpathSync(
  new URL("./fixtures/rpc-loopback-server-cert.pem", import.meta.url),
);
const serverPrivateKeyPath = realpathSync(
  new URL("./fixtures/rpc-loopback-server-key.pem", import.meta.url),
);
const serverTlsOptions = Object.freeze({
  cert: readFileSync(serverCertificatePath),
  key: readFileSync(serverPrivateKeyPath),
});
const childEnvironmentNames = new Set([
  "LITTLEJOHN_RELEASE_ASSET_SOURCE_URL",
  "LITTLEJOHN_RPC_URL",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
]);
const asciiUpperCase = (value) =>
  value.replace(/[a-z]/gu, (character) => character.toUpperCase());
const walletAddress = "0x1111111111111111111111111111111111111111";
const alternateWalletAddress = "0x3333333333333333333333333333333333333333";
const walletAddresses = Object.freeze([walletAddress, alternateWalletAddress]);
const nativeBalanceRaw = "4200000000000000000";
const officialTokens = Object.freeze([
  {
    assetUid: "0x00000000000000000000000000000000c2425be3658540dd8e2424cbf3c5c649",
    address: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
    name: "Apple • Robinhood Token",
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
const aaplOfficialToken = officialTokens.find((token) => token.symbol === "AAPL");
if (aaplOfficialToken === undefined) throw new TypeError("Fake AAPL authority is unavailable.");
const customTokenAddress = `0x${"28".repeat(20)}`;
const uniswapV2FactoryAddress = "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f";
const uniswapV2PairAddress = "0x590fa5a18e1086b3a0f0b8a6a29e07c4e1c88856";
const uniswapV2PairRuntimeCode = "0x6002600055";
const uniswapV2Reserve0 = "2000000000000000000000";
const uniswapV2Reserve1 = "1000000000000000000000";
const inspectedContractAddress = `0x${"29".repeat(20)}`;
const inspectedContractRuntimeCode = "0x600060005260206000f3";
const inspectedContractCodeHash = "0x52262f711ffacf04147d1bc4b323c69df60a55163b5b86666f3c227f25a34008";
const inspectedTransactionHash = `0x${"77".repeat(32)}`;
const inspectedTransactionFrom = `0x${"44".repeat(20)}`;
const inspectedTransactionTo = `0x${"55".repeat(20)}`;
const inspectedTransactionValue = "9007199254740993";
const inspectedTransactionInput = `0x${"ab".repeat(2_000_000)}`;
const undecodedLogData = `0x${"cd".repeat(2_000_000)}`;
const accessListStorageKey = `0x${"66".repeat(32)}`;
const undecodedLogTopic = `0x${"aa".repeat(32)}`;
const erc20TransferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const tokenAddresses = Object.freeze([
  ...officialTokens.map((token) => token.address),
  customTokenAddress,
]);
const canonicalBlockReference = Object.freeze({ blockHash, requireCanonical: true });
const eip1967StorageSlots = Object.freeze(new Set([
  stockFactoryImplementationSlot,
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
]));

const uint256Result = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const addressResult = (address) => `0x${address.slice(2).padStart(64, "0")}`;
const uniswapV2ReservesResult = `0x${[
  uniswapV2Reserve0,
  uniswapV2Reserve1,
  "0",
].map((value) => BigInt(value).toString(16).padStart(64, "0")).join("")}`;

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

const indexedAddress = (address) => `0x${address.slice(2).padStart(64, "0")}`;
const inspectedTransaction = Object.freeze({
  hash: inspectedTransactionHash,
  from: inspectedTransactionFrom,
  to: inspectedTransactionTo,
  value: `0x${BigInt(inspectedTransactionValue).toString(16)}`,
  input: inspectedTransactionInput,
  nonce: "0x2",
  gas: "0x7a1200",
  type: "0x1",
  chainId: "0x1237",
  accessList: [{ address: inspectedContractAddress, storageKeys: [accessListStorageKey] }],
  gasPrice: "0x3b9aca00",
  blockNumber,
  blockHash,
  transactionIndex: "0x0",
});
const inspectedTransactionReceipt = Object.freeze({
  transactionHash: inspectedTransactionHash,
  from: inspectedTransactionFrom,
  to: inspectedTransactionTo,
  type: "0x1",
  transactionIndex: "0x0",
  blockNumber,
  blockHash,
  status: "0x1",
  cumulativeGasUsed: "0x7a1200",
  gasUsed: "0x6acfc0",
  effectiveGasPrice: "0x3b9aca00",
  contractAddress: null,
  logs: [{
    address: inspectedContractAddress,
    topics: [undecodedLogTopic],
    data: undecodedLogData,
    logIndex: "0x0",
    transactionIndex: "0x0",
    transactionHash: inspectedTransactionHash,
    blockNumber,
    blockHash,
    removed: false,
  }, {
    address: fakeToken.address,
    topics: [
      erc20TransferTopic,
      indexedAddress(inspectedTransactionFrom),
      indexedAddress(inspectedTransactionTo),
    ],
    data: uint256Result(fakeToken.accountBalanceRaw),
    logIndex: "0x1",
    transactionIndex: "0x0",
    transactionHash: inspectedTransactionHash,
    blockNumber,
    blockHash,
    removed: false,
  }],
});
const inspectedTransactionBlock = Object.freeze({
  number: blockNumber,
  hash: blockHash,
  timestamp: blockTimestamp,
  transactions: [inspectedTransactionHash],
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
  if (data === "0x7706ba52") return boolResult(false);
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

const uniswapV2PairFor = (data) => {
  if (!/^0xe6a43905[0-9a-f]{128}$/u.test(data)) return undefined;
  const tokenA = `0x${data.slice(34, 74)}`;
  const tokenB = `0x${data.slice(98, 138)}`;
  const direct =
    (tokenA === customTokenAddress && tokenB === verifiedFakeOfficialCandidate.address) ||
    (tokenB === customTokenAddress && tokenA === verifiedFakeOfficialCandidate.address);
  return addressResult(direct ? uniswapV2PairAddress : `0x${"0".repeat(40)}`);
};

const uniswapV2PairCallResult = (data) => {
  if (data === "0xc45a0155") return addressResult(uniswapV2FactoryAddress);
  if (data === "0x0dfe1681") return addressResult(verifiedFakeOfficialCandidate.address);
  if (data === "0xd21220a7") return addressResult(customTokenAddress);
  if (data === "0x0902f1ac") return uniswapV2ReservesResult;
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
    (params[0] === "latest" || params[0] === blockNumber) &&
    params[1] === false
  ) return inspectedTransactionBlock;
  if (
    method === "eth_getBlockByHash" &&
    params.length === 2 &&
    params[0] === blockHash &&
    params[1] === false
  ) return inspectedTransactionBlock;
  if (
    method === "eth_getTransactionByHash" &&
    params.length === 1 &&
    params[0] === inspectedTransactionHash
  ) return inspectedTransaction;
  if (
    method === "eth_getTransactionReceipt" &&
    params.length === 1 &&
    params[0] === inspectedTransactionHash
  ) return inspectedTransactionReceipt;
  if (
    method === "eth_getCode" &&
    params.length === 2 &&
    exactBlockReference(params[1])
  ) {
    if (params[0] === stockFactoryProxyAddress) return stockFactoryProxyCodeFixture;
    if (params[0] === stockFactoryImplementationAddress) {
      return stockFactoryImplementationCodeFixture;
    }
    if (params[0] === inspectedContractAddress) return inspectedContractRuntimeCode;
    if (params[0] === uniswapV2FactoryAddress) return uniswapV2FactoryRuntimeCodeFixture;
    if (params[0] === uniswapV2PairAddress) return uniswapV2PairRuntimeCode;
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
    method === "eth_getStorageAt" &&
    params.length === 3 &&
    (
      params[0] === inspectedContractAddress ||
      params[0] === uniswapV2FactoryAddress ||
      token !== undefined
    ) &&
    eip1967StorageSlots.has(params[1]) &&
    exactBlockReference(params[2])
  ) return `0x${"0".repeat(64)}`;
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
        factoryMappedAddress(params[0].data) !== undefined) ||
      (params[0].to === uniswapV2FactoryAddress &&
        uniswapV2PairFor(params[0].data) !== undefined) ||
      (params[0].to === uniswapV2PairAddress &&
        uniswapV2PairCallResult(params[0].data) !== undefined))
  ) {
    if (token !== undefined) return callResult(token, params[0].data);
    if (params[0].to === stockFactoryProxyAddress) {
      return factoryMappedAddress(params[0].data);
    }
    if (params[0].to === uniswapV2FactoryAddress) {
      return uniswapV2PairFor(params[0].data);
    }
    return uniswapV2PairCallResult(params[0].data);
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
  const server = createServer(serverTlsOptions, (request, response) => {
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
  const url = `https://127.0.0.1:${address.port}`;
  const assetSourceUrl = `${url}/rhj/assets`;
  const createChildEnvironment = (base, exactRpcUrl = url) => {
    let exactRpcTarget;
    try { exactRpcTarget = new URL(exactRpcUrl); }
    catch { throw new TypeError("Fake RPC child URL is invalid."); }
    if (
      exactRpcTarget.origin !== new URL(url).origin ||
      exactRpcTarget.pathname !== "/" ||
      exactRpcTarget.search !== "" ||
      exactRpcTarget.hash !== "" ||
      exactRpcTarget.username !== "" ||
      exactRpcTarget.password !== ""
    ) throw new TypeError("Fake RPC child URL must identify the fake RPC root.");
    const entries = Object.entries(base).filter(([name, value]) =>
      typeof value === "string" &&
      !childEnvironmentNames.has(asciiUpperCase(name)));
    entries.push(
      ["LITTLEJOHN_RELEASE_ASSET_SOURCE_URL", assetSourceUrl],
      ["LITTLEJOHN_RPC_URL", exactRpcUrl],
      ["NODE_EXTRA_CA_CERTS", caCertificatePath],
    );
    return Object.freeze(Object.fromEntries(entries));
  };
  return Object.freeze({
    url,
    assetSourceUrl,
    caCertificatePath,
    createChildEnvironment,
    nativeBalanceRaw,
    token: fakeToken,
    defaultTokens: fakeTokens.slice(0, 5),
    officialCandidate: verifiedFakeOfficialCandidate,
    tokens: fakeTokens,
    canonicalBlockReference,
    stockTokenTradeHistory: Object.freeze({
      symbol: "AAPL",
      tokenAddress: aaplOfficialToken.address,
    }),
    semanticReads: Object.freeze({
      account: Object.freeze({
        address: walletAddress,
        nativeBalanceRaw,
        token: fakeToken,
      }),
      contract: Object.freeze({
        address: inspectedContractAddress,
        runtimeCode: inspectedContractRuntimeCode,
        byteLength: "10",
        codeHash: inspectedContractCodeHash,
      }),
      transaction: Object.freeze({
        transactionHash: inspectedTransactionHash,
        from: inspectedTransactionFrom,
        to: inspectedTransactionTo,
        valueRaw: inspectedTransactionValue,
        input: inspectedTransactionInput,
        nonce: "2",
        gasLimitRaw: "8000000",
        type: "1",
        gasPriceRaw: "1000000000",
        blockNumber: BigInt(blockNumber).toString(10),
        transactionIndex: "0",
        cumulativeGasUsedRaw: "8000000",
        gasUsedRaw: "7000000",
        accessListAddress: inspectedContractAddress,
        accessListStorageKey,
        undecodedLogData,
        transferToken: fakeToken.address,
        transferFrom: inspectedTransactionFrom,
        transferTo: inspectedTransactionTo,
        transferAmountRaw: fakeToken.accountBalanceRaw,
        transaction: inspectedTransaction,
        receipt: inspectedTransactionReceipt,
      }),
      uniswapV2: Object.freeze({
        factory: uniswapV2FactoryAddress,
        pair: uniswapV2PairAddress,
        tokenIn: fakeToken,
        tokenOut: verifiedFakeOfficialCandidate,
        reserve0: uniswapV2Reserve0,
        reserve1: uniswapV2Reserve1,
      }),
    }),
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
