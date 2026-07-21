import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  chainAnchorSchema,
  parseEvmAddressInput,
  parseEvmChainId,
  sourceReferenceSchema,
  tokenStandardObservationResultSchema,
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
import {
  tokenCatalogOperationSchema,
  tokenSelectionDetailSchema,
  tokenSelectionSchema,
  type TokenCatalogOperation,
  type TokenSelection,
  type TokenSelectionDetail,
} from "../../src/token-catalog/contract-schema.js";
import { tokenCatalogErrorRegistry } from "../../src/token-catalog/errors.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import type {
  TokenCatalogOperationKind,
  TokenCatalogOperationState,
} from "../../src/token-catalog/state.js";
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
      standards: tokenStandardObservationResultSchema.parse({
        asset: input.asset,
        block,
        standards: [
          { standardId: "erc20_read_surface", status: "observed" },
          { standardId: "erc165", status: "not_supported" },
          { standardId: "erc8056", status: "unknown" },
          { standardId: "erc8056_pending_multiplier", status: "unknown" },
          { standardId: "erc8056_conversion", status: "unknown" },
          { standardId: "erc8056_balances", status: "unknown" },
        ],
      }),
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

export const createTokenSelection = (
  inspection: TokenInspectionSuccess,
  options: Readonly<{
    included?: boolean;
    revisionByte?: number;
    createdAt?: string;
    updatedAt?: string;
  }> = {},
): TokenSelection => tokenSelectionSchema.parse({
  account: { chainId: inspection.data.asset.chainId, address: walletAddress },
  asset: inspection.data.asset,
  included: options.included ?? true,
  revision: Buffer.alloc(16, options.revisionByte ?? 1).toString("base64url"),
  createdAt: options.createdAt ?? "2026-07-18T00:00:01.000Z",
  updatedAt: options.updatedAt ?? options.createdAt ?? "2026-07-18T00:00:01.000Z",
});

export const createTokenSelectionDetail = (
  inspection: TokenInspectionSuccess,
  options: Parameters<typeof createTokenSelection>[1] = {},
): TokenSelectionDetail => tokenSelectionDetailSchema.parse({
  selection: createTokenSelection(inspection, options),
  historicalInspection: inspection,
});

export const createTokenOperation = async (options: Readonly<{
  kind: TokenCatalogOperationKind;
  state: TokenCatalogOperationState;
  interactionInterface?: "cli" | "web";
  operationId?: string;
}>): Promise<TokenCatalogOperation> => {
  const inspection = await createInspectionSuccess();
  const previousSelection = options.kind === "remove"
    ? createTokenSelection(inspection)
    : null;
  const createdAt = "2026-07-18T00:00:03.000Z";
  const completedSelection = createTokenSelection(inspection, {
    included: options.kind === "add",
    revisionByte: 2,
    createdAt: previousSelection?.createdAt ?? createdAt,
    updatedAt: "2026-07-18T00:00:04.000Z",
  });
  return tokenCatalogOperationSchema.parse({
    operationId: options.operationId ?? Buffer.alloc(32, options.kind === "add" ? 1 : 2).toString("base64url"),
    kind: options.kind,
    state: options.state,
    interactionInterface: options.interactionInterface ?? "web",
    createdAt,
    expiresAt: "2026-07-18T00:05:03.000Z",
    account: completedSelection.account,
    connectionRevision: "1",
    asset: completedSelection.asset,
    review: {
      previousSelection,
      selectionSetRevision: Buffer.alloc(16, 3).toString("base64url"),
      inspection: options.kind === "add" ? inspection : null,
      officialSnapshotRevision: options.kind === "add"
        ? Buffer.alloc(16, 4).toString("base64url")
        : null,
      officialEvidence: null,
      reviewDigest: `0x${"ef".repeat(32)}`,
    },
    result: options.state === "completed"
      ? { selection: completedSelection, historicalInspection: inspection }
      : null,
    failure: options.state === "failed"
      ? new TokenCatalogOperationError("state_conflict").failure
      : null,
  });
};
