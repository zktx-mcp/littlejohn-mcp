import { vi } from "vitest";
import { createRequire } from "node:module";
import {
  CapabilityBindingRegistry, CapabilityRegistry, ObservationAuthorityRegistry,
  createCanonicalClock, createCapabilityInvocationAuthority, createObservationAuthority,
  chainAnchorSchema, parseEvmAddress, parseHash32, parseHexBytes, parseUnsignedDecimal,
  sourceReferenceSchema, type EvmAddress,
} from "../../src/core/index.js";
import { createChainInvocationLifecycle, type PinnedEvmReadPort, type ChainInvocationContext, type CanonicalBlock } from "../../src/chain/index.js";
import {
  assertCommittedOfficialAssetSnapshot, officialAssetCandidateListDigest, officialAssetMemberSetDigest,
  officialAssetSnapshotRevisionSchema, officialAssetSourceDefinition, stockFactoryAdmissionManifest,
  stockFactoryVerificationSchema, type OfficialAssetSourceMember,
} from "../../src/registry/official-asset-contract.js";
import { createStockTokenTradeHistoryObservationAuthorities } from "../../src/stock-token-trade-history/application-factory.js";
import { createProtocolOwnerApplication } from "../../src/protocols/runtime.js";
import { createDexScreenerPoolCandidateSource } from "../../src/stock-token-prices/dexscreener-source.js";
import { createStockTokenPriceApplication } from "../../src/stock-token-prices/application.js";
import { stockTokenPricesCapability, stockTokensCapability } from "../../src/stock-token-prices/contracts.js";
import type { RuntimeRouteRegistry } from "../../src/runtime/http-routing.js";

const { encodeAbiParameters, toFunctionSelector } = createRequire(import.meta.url)("viem") as {
  encodeAbiParameters(types: readonly unknown[], values: readonly unknown[]): string;
  toFunctionSelector(signature: string): string;
};
export { toFunctionSelector };

export const stock = parseEvmAddress("0xaf3d76f1834a1d425780943c99ea8a608f8a93f9");
export const usdg = parseEvmAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
export const v2Pool = "0x0000000000000000000000000000000000000012";
export const v3Pool = "0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d";
export const v4Pool = "0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb";
export const dynamicPool = "0xa2347ba69167e5602f74640ffbf737ee7cdd825e4726d3462564fc6533070147";
export const block = chainAnchorSchema.parse({ chainId: "eip155:4663", blockNumber: "100",
  blockHash: `0x${"1".repeat(64)}`, blockTimestamp: "2026-09-16T08:00:00.000Z" });
export const member: OfficialAssetSourceMember = { assetUid: parseHash32(`0x${"7".repeat(64)}`),
  contractAddress: stock, sourceName: "Apple", sourceSymbol: "AAPL" };
export const candidateRow = (version = "v4", poolId = v4Pool) => ({ chainId: "robinhood", dexId: "uniswap",
  labels: [version], pairAddress: poolId, baseToken: { address: stock }, quoteToken: { address: usdg }, priceUsd: "999999999" });

// Each chunk fits the accepted 1 MiB raw-body budget. Only their sum exceeds
// it; keeping any prefix after [] or dropping the second chunk still parses.
export const oversizedCandidateResponse = (cancel?: () => void | Promise<void>): Response =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("[]" + " ".repeat(524_287)));
      controller.enqueue(new TextEncoder().encode(" ".repeat(524_288)));
    },
    pull(controller) { controller.close(); },
    ...(cancel === undefined ? {} : { cancel }),
  }, { highWaterMark: 0 }));

// Independent captured code-identity inputs for the admitted Chain port. This
// fixture tests the native reader, not Chain's bytecode hashing implementation.
const deployments = {
  v2: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
  v3: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  manager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  view: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  positions: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
} as const;
const codeIdentities: Record<string, { byteLength: string; codeHash: string }> = {
  [deployments.v2]: { byteLength: "13859", codeHash: "0xbab145d02e7005f0d84c6c1639d39b799b0ea16df99ebbdaf5a14d9da820b4e0" },
  [deployments.v3]: { byteLength: "24535", codeHash: "0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739" },
  [deployments.manager]: { byteLength: "24009", codeHash: "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626" },
  [deployments.view]: { byteLength: "3531", codeHash: "0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6" },
  [deployments.positions]: { byteLength: "23877", codeHash: "0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2" },
};
const abiBytes = (types: readonly string[], values: readonly unknown[]) =>
  parseHexBytes(encodeAbiParameters(types.map((type) => ({ type })), values));
const oneAddress = (value: string) => abiBytes(["address"], [value]);
const noCall = async (): Promise<never> => { throw new Error("Unexpected fixture dependency call."); };

export const createPriceFixture = (options: Readonly<{
  rows?: unknown[];
  members?: OfficialAssetSourceMember[];
  fetch?: typeof fetch;
  intercept?: (address: string, selector: string) => "revert" | "empty_key" | "wrong_factory" | "wrong_manager" | "bad_bytes" | undefined;
  badCode?: boolean;
  dynamic?: boolean;
}> = {}) => {
  const clock = createCanonicalClock(() => "2026-09-16T08:00:01.000Z");
  const owner = new AbortController();
  const chain = createChainInvocationLifecycle(owner.signal);
  const officialSources = createStockTokenTradeHistoryObservationAuthorities(clock);
  const rpc = createObservationAuthority({ clock, sourceClass: "chain_rpc", owner: "Fixture RPC",
    reference: sourceReferenceSchema.parse({ kind: "public", sourceId: "price-fixture-rpc", uri: "https://rpc.example/" }) });
  const fetcher = vi.fn(options.fetch ?? (async () => new Response(JSON.stringify(options.rows ?? [
    candidateRow("v2", v2Pool), candidateRow("v3", v3Pool), candidateRow(),
  ]), { headers: { "content-type": "application/json" } })));
  const source = createDexScreenerPoolCandidateSource({ clock, fetch: fetcher });
  const members = options.members ?? [member];
  const snapshot = assertCommittedOfficialAssetSnapshot({
    sourceUri: officialAssetSourceDefinition.sourceUri, sourceObservedAt: clock.now(),
    rawResponseDigest: parseHash32(`0x${"2".repeat(64)}`),
    memberSetDigest: officialAssetMemberSetDigest(members), candidateListDigest: officialAssetCandidateListDigest(members),
    chainId: block.chainId, members, revision: officialAssetSnapshotRevisionSchema.parse(Buffer.alloc(16, 1).toString("base64url")), updatedAt: clock.now(),
  });
  const calls: Array<{ address: string; data: string; block: unknown }> = [];
  const codeReads = vi.fn(async (_context: ChainInvocationContext, _anchor: CanonicalBlock, address: EvmAddress) => {
    const identity = codeIdentities[address];
    if (identity === undefined) throw new Error("Unexpected code target.");
    return { bytecode: parseHexBytes("0x00"), identity: { byteLength: parseUnsignedDecimal(identity.byteLength),
      codeHash: parseHash32(options.badCode ? `0x${"9".repeat(64)}` : identity.codeHash) } };
  });
  const reads: PinnedEvmReadPort = {
    observationAuthority: rpc, resolveBlock: noCall, readRuntimeCode: codeReads,
    async call(_context, anchor, request) {
      calls.push({ address: request.to, data: request.data, block: anchor.anchor });
      const selector = request.data.slice(0, 10);
      const change = options.intercept?.(request.to, selector);
      if (change === "revert") return { status: "reverted" };
      if (change === "bad_bytes") return { status: "observed", value: parseHexBytes("0x01") };
      let result;
      // Signatures and return shapes are taken from the public protocol ABIs,
      // independently of the reader's codec declarations.
      if (selector === toFunctionSelector("poolManager()")) result = oneAddress(change === "wrong_manager" ? v2Pool : deployments.manager);
      else if (selector === toFunctionSelector("poolKeys(bytes25)")) result = change === "empty_key"
        ? abiBytes(["address", "address", "uint24", "int24", "address"], ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0, 0, "0x0000000000000000000000000000000000000000"])
        : abiBytes(["address", "address", "uint24", "int24", "address"], options.dynamic
          ? [usdg, stock, 0x800000, 10, "0x70a9a88402989226847ec122043ce5e7ff462080"]
          : [usdg, stock, 3000, 60, "0x0000000000000000000000000000000000000000"]);
      else if (selector === toFunctionSelector("factory()")) result = oneAddress(change === "wrong_factory" ? v2Pool : request.to === v2Pool ? deployments.v2 : deployments.v3);
      else if (selector === toFunctionSelector("getPair(address,address)")) result = oneAddress(v2Pool);
      else if (selector === toFunctionSelector("getPool(address,address,uint24)")) result = oneAddress(v3Pool);
      else if (selector === toFunctionSelector("token0()")) result = oneAddress(usdg);
      else if (selector === toFunctionSelector("token1()")) result = oneAddress(stock);
      else if (selector === toFunctionSelector("fee()")) result = abiBytes(["uint24"], [500]);
      else if (selector === toFunctionSelector("tickSpacing()")) result = abiBytes(["int24"], [10]);
      else if (selector === toFunctionSelector("getReserves()")) result = abiBytes(["uint112", "uint112", "uint32"], [1_000_000n, 1_000_000_000_000_000_000n, 1n]);
      else if (selector === toFunctionSelector("slot0()")) result = abiBytes(["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"], [79228162514264337593543950336000000n, 276324, 0, 1, 1, 0, true]);
      else if (selector === toFunctionSelector("getSlot0(bytes32)")) result = abiBytes(["uint160", "int24", "uint24", "uint24"], [79228162514264337593543950336000000n, 276324, options.dynamic ? 1024500 : 0, options.dynamic ? 1500 : 3000]);
      else throw new Error(`Unexpected call selector ${selector}`);
      return { status: "observed", value: result };
    },
    readTokenDecimals: vi.fn(async (_context, _block, address) => ({ status: "observed" as const, value: parseUnsignedDecimal(address === usdg ? "6" : "18") })),
    readTokenDisplayScaling: noCall, inspectContract: noCall, inspectContractExecution: noCall, recordConfiguredChain: () => { throw new Error("Unexpected evidence callback."); },
  };
  const officialAssets = { synchronize: vi.fn(async () => ({ status: "current" as const, snapshot })), readStored: () => snapshot, close: async () => undefined };
  const ports = { observations: new ObservationAuthorityRegistry(clock, [rpc, officialSources.officialAsset, source.observationAuthorityRegistration]) };
  const invocationAuthority = createCapabilityInvocationAuthority(clock, block.chainId);
  const protocols = createProtocolOwnerApplication({ routes: {} as RuntimeRouteRegistry,
    officialAssets, officialAssetObservationAuthority: officialSources.officialAsset,
    invocations: chain, reads, invocationAuthority, invocationPorts: ports });
  const verification = stockFactoryVerificationSchema.parse({ assetUid: member.assetUid, contractAddress: stock, block,
    proxyAddress: stockFactoryAdmissionManifest.proxyAddress, proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
    implementationAddress: stockFactoryAdmissionManifest.implementationAddress, implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
    tokenCodeHash: `0x${"3".repeat(64)}` });
  const application = createStockTokenPriceApplication({ admission: { isOpen: true }, ownerSignal: owner.signal,
    chainInvocations: chain, currentBlockReads: { resolveCurrentBlock: async () => ({ anchor: block }) },
    officialAssetReads: { verifyAtBlock: async () => ({ status: "verified", member, verification }), verifyManyAtBlock: noCall },
    protocolReads: reads, poolReads: protocols.poolPrices, officialAssets, source,
    officialAssetObservationAuthority: officialSources.officialAsset, invocationAuthority, invocationPorts: ports });
  const bindings = new CapabilityBindingRegistry(new CapabilityRegistry([stockTokenPricesCapability, stockTokensCapability]), [application.prices, application.tokens]);
  return { application, bindings, owner, calls, codeReads, fetcher, source, snapshot, ports, clock, officialAuthority: officialSources.officialAsset,
    async close() { await application.close(); await source.close(); await chain.close(); } };
};
