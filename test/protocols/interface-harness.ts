import {
  chainAnchorSchema,
  createContractAnalysisChainClaims,
  createContractAnalysisSourceClaim,
  contractRuntimeCodeIdentitySchema,
  deepFreezeValue,
  keccak256FromHex,
  parseEvmAddressInput,
  parseHexBytes,
  parseUnsignedDecimal,
  type CapabilitySuccess,
  type ContractAnalysis,
  type HexBytes,
  type ObservationWriter,
} from "../../src/core/index.js";
import {
  extendProtocolRuntimeSupportManifest,
  type ProtocolRuntimeSupportManifest,
  type StockTokenTradeHistoryRuntimeSupportManifest,
} from "../../src/runtime/support-manifest.js";
import {
  createChainInvocationLifecycle,
  type ChainInvocationContext,
} from "../../src/chain/invocation-lifecycle.js";
import type {
  PinnedEvmCallResult,
  PinnedEvmReadPort,
} from "../../src/chain/protocol-reads.js";
import {
  createProtocolRegistrySupportExtension,
  ProtocolRegistry,
  readProtocolSupportExtension,
  type ProtocolSupportExtension,
} from "../../src/protocols/index.js";
import {
  createUniswapV2QuoteApplication,
  uniswapV2ErrorRegistry,
  uniswapV2FactoryAddress,
  uniswapV2FactoryRuntimeCodeIdentity,
  uniswapV2PairInitCodeHash,
  uniswapProtocolFamily,
  uniswapV2PackageDescriptor,
  uniswapV2ProtocolId,
  uniswapV2QuoteCapability,
  uniswapV2QuoteCapabilityId,
  type UniswapV2QuoteData,
  type UniswapV2QuoteInput,
} from "../../src/protocols/uniswap-v2/index.js";
import {
  computeUniswapV2PairAddress,
  orderedTokenAddresses,
} from "../../src/protocols/uniswap-v2/quote.js";
import {
  bindForHarness,
  createCapabilityHarness,
  invokeBinding,
} from "../core/capability-harness.js";
import {
  uniswapV2FactoryRuntimeCodeFixture,
} from "../../scripts/release/uniswap-v2-factory-fixture.mjs";

const interfaceBlock = deepFreezeValue({
  anchor: chainAnchorSchema.parse({
    chainId: "eip155:4663",
    blockNumber: "20056525",
    blockHash: `0x${"ab".repeat(32)}`,
    blockTimestamp: "2026-07-27T00:00:00.000Z",
  }),
});
const zeroAddress = parseEvmAddressInput(`0x${"00".repeat(20)}`);
const addressWord = (address: string): HexBytes =>
  parseHexBytes(`0x${address.slice(2).padStart(64, "0")}`);
const reservesResult = (reserve0: bigint, reserve1: bigint): HexBytes =>
  parseHexBytes(
    `0x${reserve0.toString(16).padStart(64, "0")}` +
      `${reserve1.toString(16).padStart(64, "0")}` +
      `${"0".repeat(64)}`,
  );

const interfaceFactoryAnalysis = (): ContractAnalysis => deepFreezeValue({
  chainId: interfaceBlock.anchor.chainId,
  target: uniswapV2FactoryAddress,
  block: interfaceBlock.anchor,
  targetRuntimeCode: uniswapV2FactoryRuntimeCodeIdentity,
  proxy: { status: "no_supported_proxy_observed" },
  sources: [{
    role: "target",
    address: uniswapV2FactoryAddress,
    status: "no_record_observed",
  }],
  declaredFunctions: {
    status: "unavailable",
    reason: "exact_abi_unavailable",
  },
  controls: {
    owner: { status: "unavailable", reason: "exact_abi_unavailable" },
    paused: { status: "unavailable", reason: "exact_abi_unavailable" },
    defaultAdmins: { status: "unavailable", reason: "exact_abi_unavailable" },
  },
});

const recordInterfaceFactoryAnalysis = (
  observations: ObservationWriter,
  fragment: Parameters<PinnedEvmReadPort["inspectContract"]>[3]["fragment"],
  analysis: ContractAnalysis,
  chainAuthority: PinnedEvmReadPort["observationAuthority"],
  sourceAuthority: ReturnType<
    ReturnType<typeof createCapabilityHarness>["contractVerificationSource"]
  >,
): void => {
  const deployment = observations.bind(fragment.targets.deployment);
  const targetSource = observations.bind(fragment.targets.targetSource);
  observations.record(deployment.slot, {
    source: chainAuthority,
    claims: [{
      role: deployment.roles.value,
      value: createContractAnalysisChainClaims(analysis).deployment,
      chainAnchor: analysis.block,
    }],
  });
  observations.record(targetSource.slot, {
    source: sourceAuthority,
    claims: [{
      role: targetSource.roles.value,
      value: createContractAnalysisSourceClaim(analysis, "target"),
      chainAnchor: analysis.block,
    }],
  });
};

const createUniswapV2InterfaceSuccess = async (
  input: UniswapV2QuoteInput,
  directPair: Readonly<{
    readonly address: ReturnType<typeof parseEvmAddressInput>;
    readonly token0: ReturnType<typeof parseEvmAddressInput>;
    readonly token1: ReturnType<typeof parseEvmAddressInput>;
    readonly reserve0: bigint;
    readonly reserve1: bigint;
  }> | undefined,
): Promise<CapabilitySuccess<UniswapV2QuoteData>> => {
  const harness = createCapabilityHarness();
  const lifecycle = createChainInvocationLifecycle(new AbortController().signal);
  const chainAuthority = harness.ports.observations.get("chain_rpc");
  const reads: PinnedEvmReadPort = {
    observationAuthority: chainAuthority,
    async resolveBlock() {
      return interfaceBlock;
    },
    async readRuntimeCode(_context, _block, address) {
      if (address === uniswapV2FactoryAddress) {
        const bytecode = parseHexBytes(uniswapV2FactoryRuntimeCodeFixture);
        return {
          bytecode,
          identity: contractRuntimeCodeIdentitySchema.parse({
            byteLength: String((bytecode.length - 2) / 2),
            codeHash: keccak256FromHex(bytecode),
          }),
        };
      }
      if (address !== directPair?.address) {
        throw new TypeError("An absent pair must not be read as runtime code.");
      }
      const bytecode = parseHexBytes("0x6001");
      return {
        bytecode,
        identity: contractRuntimeCodeIdentitySchema.parse({
          byteLength: "2",
          codeHash: keccak256FromHex(bytecode),
        }),
      };
    },
    async call(
      _context: ChainInvocationContext,
      _block,
      request,
    ): Promise<PinnedEvmCallResult<HexBytes>> {
      if (request.to === uniswapV2FactoryAddress) {
        const directSelector = parseHexBytes(
          `0xe6a43905${input.tokenIn.address.slice(2).padStart(64, "0")}` +
            `${input.tokenOut.address.slice(2).padStart(64, "0")}`,
        );
        return {
          status: "observed",
          value: addressWord(
            directPair !== undefined && request.data === directSelector
              ? directPair.address
              : zeroAddress,
          ),
        };
      }
      if (directPair === undefined || request.to !== directPair.address) {
        throw new TypeError("Unexpected V2 interface pair call.");
      }
      if (request.data === parseHexBytes("0xc45a0155")) {
        return { status: "observed", value: addressWord(uniswapV2FactoryAddress) };
      }
      if (request.data === parseHexBytes("0x0dfe1681")) {
        return { status: "observed", value: addressWord(directPair.token0) };
      }
      if (request.data === parseHexBytes("0xd21220a7")) {
        return { status: "observed", value: addressWord(directPair.token1) };
      }
      if (request.data === parseHexBytes("0x0902f1ac")) {
        return {
          status: "observed",
          value: reservesResult(directPair.reserve0, directPair.reserve1),
        };
      }
      throw new TypeError("Unexpected V2 interface pair selector.");
    },
    async readTokenDecimals() {
      return { status: "observed", value: parseUnsignedDecimal("18") };
    },
    async inspectContract(_context, _block, _target, evidence) {
      const analysis = interfaceFactoryAnalysis();
      recordInterfaceFactoryAnalysis(
        evidence.observations,
        evidence.fragment,
        analysis,
        chainAuthority,
        harness.contractVerificationSource(uniswapV2FactoryAddress),
      );
      return analysis;
    },
    recordConfiguredChain(_context, currentBlock, observations, target) {
      observations.record(target.slot, {
        source: chainAuthority,
        claims: [{
          role: target.roles.chainId,
          value: currentBlock.anchor.chainId,
          chainAnchor: currentBlock.anchor,
        }],
      });
    },
  };
  const application = createUniswapV2QuoteApplication({
    invocations: lifecycle,
    reads,
    invocationAuthority: harness.invocationAuthority,
    invocationPorts: harness.ports,
  });
  try {
    const result = await invokeBinding(
      uniswapV2QuoteCapability,
      application.binding,
      input,
    );
    if (!result.ok) {
      throw new TypeError(
        `Expected V2 interface success, received ${result.error.code}: ` +
          JSON.stringify(result.error.issues),
      );
    }
    return result;
  } finally {
    await lifecycle.close();
  }
};

export const createUniswapV2AllPairsAbsentSuccess = (
  input: UniswapV2QuoteInput,
): Promise<CapabilitySuccess<UniswapV2QuoteData>> =>
  createUniswapV2InterfaceSuccess(input, undefined);

export const createUniswapV2DirectQuoteSuccess = (
  input: UniswapV2QuoteInput,
): Promise<CapabilitySuccess<UniswapV2QuoteData>> => {
  const [token0, token1] = orderedTokenAddresses(
    input.tokenIn.address,
    input.tokenOut.address,
  );
  return createUniswapV2InterfaceSuccess(input, {
    address: computeUniswapV2PairAddress({
      factory: uniswapV2FactoryAddress,
      tokenA: input.tokenIn.address,
      tokenB: input.tokenOut.address,
      pairInitCodeHash: uniswapV2PairInitCodeHash,
    }),
    token0,
    token1,
    reserve0: token0 === input.tokenOut.address
      ? 2_000_000_000_000_000_000_000n
      : 1_000_000_000_000_000_000_000n,
    reserve1: token1 === input.tokenOut.address
      ? 2_000_000_000_000_000_000_000n
      : 1_000_000_000_000_000_000_000n,
  });
};

export const extendUniswapV2ProtocolHarnessManifest = (
  parent: StockTokenTradeHistoryRuntimeSupportManifest,
): ProtocolRuntimeSupportManifest => extendProtocolRuntimeSupportManifest(
  parent,
  readProtocolSupportExtension(uniswapV2ProtocolHarnessSupportExtension()),
);

export const uniswapV2ProtocolHarnessSupportExtension = (
): ProtocolSupportExtension => createProtocolRegistrySupportExtension(
  new ProtocolRegistry([uniswapProtocolFamily], [uniswapV2PackageDescriptor]),
  {
    capabilities: [{
      capabilityId: uniswapV2QuoteCapabilityId,
      availability: {
        overall: "internal",
        direct: "internal",
        http: "unavailable",
        mcp: "unavailable",
        cli: "unavailable",
      },
    }],
  },
);

export const uniswapV2QuoteHarnessBinding = () => bindForHarness(
  uniswapV2QuoteCapability,
  createCapabilityHarness(),
  async () => ({ status: "failure", code: "internal_error", issues: [] }),
  uniswapV2ErrorRegistry,
);
