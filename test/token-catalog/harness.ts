import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  chainAnchorSchema,
  parseEvmAddressInput,
  parseEvmChainId,
  sourceReferenceSchema,
  type CanonicalJson,
  type SourceReference,
} from "../../src/core/index.js";
import {
  tokenInspectCapability,
  tokenInspectionDataSchema,
  type TokenInspectionData,
  type TokenInspectionInput,
  type TokenInspectionSuccess,
} from "../../src/token-catalog/contracts.js";
import { tokenCatalogErrorRegistry } from "../../src/token-catalog/errors.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";

export const tokenAddress = parseEvmAddressInput(`0x${"12".repeat(20)}`);
export const walletAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
export const chainId = parseEvmChainId("eip155:4663");

export interface InspectionHarnessOptions {
  readonly chainRpc?: Readonly<{ owner: string; reference: SourceReference }>;
  readonly name?: string;
  readonly symbol?: string;
}

export const createInspectionBinding = (
  configuredChain = chainId,
  beforeResult?: () => Promise<void>,
  options: InspectionHarnessOptions = {},
) => {
  const configurationDigest = Buffer.alloc(32, 2).toString("base64url");
  const harness = createCapabilityHarness(
    () => "2026-07-18T00:00:02.000Z",
    configuredChain,
    options.chainRpc ?? Object.freeze({
      owner: "user_configured",
      reference: sourceReferenceSchema.parse({
        kind: "configured_rpc",
        sourceId: `rpc:${configurationDigest}`,
        publicOrigin: "https://rpc.example",
        configurationDigest,
      }),
    }),
  );
  return bindForHarness(tokenInspectCapability, harness, async (input, context, observations) => {
    await beforeResult?.();
    const source = context.ports.observations.get("chain_rpc");
    const block = chainAnchorSchema.parse({
      chainId: input.asset.chainId,
      blockNumber: "42",
      blockHash: `0x${"ab".repeat(32)}`,
      blockTimestamp: "2026-07-18T00:00:00.000Z",
    });
    observations.record("rpc_chain_id", {
      source,
      claims: [{ role: "chain_id", value: input.asset.chainId, chainAnchor: block }],
    });
    observations.record("block", {
      source,
      claims: [{ role: "token_inspection_block", value: block as unknown as CanonicalJson, chainAnchor: block }],
    });
    const runtimeCode = { byteLength: "2", codeHash: `0x${"cd".repeat(32)}` } as const;
    observations.record("runtime_code", {
      source,
      claims: [{
        role: "token_runtime_code",
        value: runtimeCode as unknown as CanonicalJson,
        asset: input.asset,
        chainAnchor: block,
      }],
    });
    const supplyObservationId = observations.record("total_supply", {
      source,
      claims: [{ role: "token_total_supply", value: "1000000", asset: input.asset, chainAnchor: block }],
    });
    const decimalsObservationId = observations.record("decimals", {
      source,
      claims: [{ role: "token_decimals", value: "18", asset: input.asset, chainAnchor: block }],
    });
    const nameObservationId = observations.record("name", {
      source,
      claims: [{ role: "token_name", value: options.name ?? "Example Token", asset: input.asset, chainAnchor: block }],
    });
    const symbolObservationId = observations.record("symbol", {
      source,
      claims: [{ role: "token_symbol", value: options.symbol ?? "EXT", asset: input.asset, chainAnchor: block }],
    });
    const totalSupply = {
      asset: input.asset,
      raw: "1000000",
      decimals: { status: "available", value: "18", observationId: decimalsObservationId },
      quantityObservationId: supplyObservationId,
    };
    const data: TokenInspectionData = tokenInspectionDataSchema.parse({
      asset: input.asset,
      block,
      runtimeCode,
      totalSupply,
      metadata: {
        name: { status: "available", value: options.name ?? "Example Token", observationId: nameObservationId },
        symbol: { status: "available", value: options.symbol ?? "EXT", observationId: symbolObservationId },
      },
    });
    return { status: "success", data };
  }, tokenCatalogErrorRegistry);
};

export const createInspectionSuccess = async (
  input: TokenInspectionInput = {
    asset: { kind: "erc20", chainId, address: tokenAddress },
    block: { kind: "latest" },
  },
  options: InspectionHarnessOptions = {},
): Promise<TokenInspectionSuccess> => {
  const binding = createInspectionBinding(input.asset.chainId, undefined, options);
  const result = await new CapabilityBindingRegistry(
    new CapabilityRegistry([tokenInspectCapability]),
    [binding],
  ).invoke(tokenInspectCapability, input, { signal: new AbortController().signal });
  if (!result.ok) throw new Error(`Inspection fixture failed: ${result.error.code}`);
  return result;
};
