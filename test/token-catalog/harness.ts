import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  assertContractAnalysisForTarget,
  chainAnchorSchema,
  contractAnalysisSchema,
  createContractAnalysisChainClaims,
  createContractAnalysisSourceClaim,
  parseEvmAddressInput,
  parseEvmChainId,
  sourceReferenceSchema,
  tokenStandardOrder,
  tokenStandardObservationResultSchema,
  type ContractAnalysis,
  type SourceReference,
} from "../../src/core/index.js";
import {
  tokenInspectCapability,
  tokenInspectionEvidence,
  tokenInspectionDataSchema,
  projectTokenInspectionStandardEvidence,
  type TokenInspectionData,
  type TokenInspectionInput,
  type TokenInspectionSuccess,
} from "../../src/token-catalog/contracts.js";
import {
  createTokenAdditionReviewProjection,
  parseTokenCatalogOperation,
  parseTokenSelectionReview,
  tokenSelectionReviewDigest,
  tokenSelectionDetailSchema,
  tokenSelectionSchema,
  type TokenCatalogOperation,
  type TokenSelection,
  type TokenSelectionDetail,
} from "../../src/token-catalog/contract-schema.js";
import { officialAssetSnapshotRevisionSchema } from "../../src/registry/index.js";
import { tokenCatalogErrorRegistry } from "../../src/token-catalog/errors.js";
import type { TokenCatalogInitiator, TokenCatalogOperationKind } from "../../src/token-catalog/state.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";

export const tokenAddress = parseEvmAddressInput(`0x${"12".repeat(20)}`);
export const walletAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
export const chainId = parseEvmChainId("eip155:4663");

export interface InspectionHarnessOptions {
  readonly analysis?: ContractAnalysis;
  readonly chainRpc?: Readonly<{ owner: string; reference: SourceReference }>;
  readonly decimals?: string;
  readonly name?: string;
  readonly runtimeByteLength?: string;
  readonly standards?: TokenInspectionData["standards"];
  readonly symbol?: string;
  readonly totalSupply?: string;
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
    const chain = observations.bind(tokenInspectionEvidence.configuredChain.target);
    const deploymentTarget = observations.bind(
      tokenInspectionEvidence.analysis.targets.deployment,
    );
    const controlsTarget = observations.bind(
      tokenInspectionEvidence.analysis.targets.controls,
    );
    const targetSourceTarget = observations.bind(
      tokenInspectionEvidence.analysis.targets.targetSource,
    );
    const implementationSourceTarget = observations.bind(
      tokenInspectionEvidence.analysis.targets.implementationSource,
    );
    const totalSupplyTarget = observations.bind(
      tokenInspectionEvidence.targets.totalSupply,
    );
    const decimalsTarget = observations.bind(tokenInspectionEvidence.targets.decimals);
    const nameTarget = observations.bind(tokenInspectionEvidence.targets.name);
    const symbolTarget = observations.bind(tokenInspectionEvidence.targets.symbol);
    const standardTargets = tokenStandardOrder.map((standardId) => Object.freeze({
      standardId,
      target: observations.bind(tokenInspectionEvidence.targets.standards[standardId]),
    }));
    const requiredErc8056Target = observations.bind(
      tokenInspectionEvidence.targets.requiredErc8056,
    );
    observations.record(chain.slot, {
      source,
      claims: [{
        role: chain.roles.chainId,
        value: input.asset.chainId,
        chainAnchor: block,
      }],
    });
    const defaultRuntimeCode = {
      byteLength: options.runtimeByteLength ?? "2",
      codeHash: `0x${"cd".repeat(32)}`,
    } as const;
    const analysis = options.analysis === undefined
      ? contractAnalysisSchema.parse({
          chainId: input.asset.chainId,
          target: input.asset.address,
          block,
          targetRuntimeCode: defaultRuntimeCode,
          proxy: { status: "no_supported_proxy_observed" },
          sources: [{
            role: "target",
            address: input.asset.address,
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
        })
      : assertContractAnalysisForTarget({
          chainId: input.asset.chainId,
          address: input.asset.address,
          block,
          runtimeCode: options.analysis.targetRuntimeCode,
        }, options.analysis);
    const chainClaims = createContractAnalysisChainClaims(analysis);
    observations.record(deploymentTarget.slot, {
      source,
      claims: [{
        role: deploymentTarget.roles.value,
        value: chainClaims.deployment,
        chainAnchor: block,
      }],
    });
    if (chainClaims.controlResults !== undefined) {
      observations.record(controlsTarget.slot, {
        source,
        claims: [{
          role: controlsTarget.roles.value,
          value: chainClaims.controlResults,
          chainAnchor: block,
        }],
      });
    }
    for (const sourceEntry of analysis.sources) {
      const sourceTarget = sourceEntry.role === "target"
        ? targetSourceTarget
        : implementationSourceTarget;
      observations.record(sourceTarget.slot, {
        source: harness.contractVerificationSource(sourceEntry.address),
        claims: [{
          role: sourceTarget.roles.value,
          value: createContractAnalysisSourceClaim(analysis, sourceEntry.role),
          chainAnchor: block,
        }],
      });
    }
    const supplyObservationId = observations.record(totalSupplyTarget.slot, {
      source,
      claims: [{
        role: totalSupplyTarget.roles.value,
        value: options.totalSupply ?? "1000000",
        asset: input.asset,
        chainAnchor: block,
      }],
    });
    const decimalsObservationId = observations.record(decimalsTarget.slot, {
      source,
      claims: [{
        role: decimalsTarget.roles.value,
        value: options.decimals ?? "18",
        asset: input.asset,
        chainAnchor: block,
      }],
    });
    const nameObservationId = observations.record(nameTarget.slot, {
      source,
      claims: [{
        role: nameTarget.roles.value,
        value: options.name ?? "Example Token",
        asset: input.asset,
        chainAnchor: block,
      }],
    });
    const symbolObservationId = observations.record(symbolTarget.slot, {
      source,
      claims: [{
        role: symbolTarget.roles.value,
        value: options.symbol ?? "EXT",
        asset: input.asset,
        chainAnchor: block,
      }],
    });
    const standards = options.standards ?? tokenStandardObservationResultSchema.parse({
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
    });
    const standardEvidence = projectTokenInspectionStandardEvidence(standards);
    for (const entry of standardTargets) {
      const projection = standardEvidence.standards[entry.standardId];
      if (projection.observationValue === undefined) continue;
      observations.record(entry.target.slot, {
        source,
        claims: [{
          role: entry.target.roles.value,
          value: projection.observationValue,
          asset: input.asset,
          chainAnchor: block,
        }],
      });
    }
    if (standardEvidence.requiredErc8056.observationValue !== undefined) {
      observations.record(requiredErc8056Target.slot, {
        source,
        claims: [{
          role: requiredErc8056Target.roles.value,
          value: standardEvidence.requiredErc8056.observationValue,
          asset: input.asset,
          chainAnchor: block,
        }],
      });
    }
    const totalSupply = {
      asset: input.asset,
      raw: options.totalSupply ?? "1000000",
      decimals: { status: "available", value: options.decimals ?? "18", observationId: decimalsObservationId },
      quantityObservationId: supplyObservationId,
    };
    const data: TokenInspectionData = tokenInspectionDataSchema.parse({
      asset: input.asset,
      analysis,
      totalSupply,
      metadata: {
        name: { status: "available", value: options.name ?? "Example Token", observationId: nameObservationId },
        symbol: { status: "available", value: options.symbol ?? "EXT", observationId: symbolObservationId },
        decimalsReadFailure: null,
      },
      standards,
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
  initiatedBy?: TokenCatalogInitiator;
  operationId?: string;
}>): Promise<TokenCatalogOperation> => {
  const inspection = await createInspectionSuccess();
  const previousSelection = options.kind === "remove"
    ? createTokenSelection(inspection)
    : null;
  const createdAt = "2026-07-18T00:00:03.000Z";
  const completedAt = "2026-07-18T00:00:04.000Z";
  const completedSelection = createTokenSelection(inspection, {
    included: options.kind === "add",
    revisionByte: 2,
    createdAt: previousSelection?.createdAt ?? completedAt,
    updatedAt: completedAt,
  });
  const operationId = options.operationId ??
    Buffer.alloc(32, options.kind === "add" ? 1 : 2).toString("base64url");
  const selectionSetRevision = Buffer.alloc(16, 3).toString("base64url");
  const reviewBase = options.kind === "add"
    ? {
        contractVersion: "1" as const,
        domain: "token_selection" as const,
        operationId,
        kind: options.kind,
        createdAt,
        actionExpiresAt: "2026-07-18T00:05:03.000Z",
        target: { asset: completedSelection.asset },
        precondition: {
          account: completedSelection.account,
          connectionRevision: "1",
          previousSelection,
          selectionSetRevision: null,
        },
        ...createTokenAdditionReviewProjection({
          inspection,
          officialSnapshotRevision: officialAssetSnapshotRevisionSchema.parse(
            Buffer.alloc(16, 4).toString("base64url"),
          ),
          officialMember: null,
          officialVerification: null,
        }),
      }
    : {
        contractVersion: "1" as const,
        domain: "token_selection" as const,
        operationId,
        kind: options.kind,
        createdAt,
        actionExpiresAt: "2026-07-18T00:05:03.000Z",
        target: { asset: completedSelection.asset },
        decision: { action: "remove_selection" as const },
        precondition: {
          account: completedSelection.account,
          connectionRevision: "1",
          previousSelection,
          selectionSetRevision,
        },
        fixedEvidence: {},
      };
  const review = parseTokenSelectionReview({
    ...reviewBase,
    reviewDigest: tokenSelectionReviewDigest(reviewBase),
  });
  return parseTokenCatalogOperation({
    contractVersion: "1",
    domain: "token_selection",
    operationId,
    kind: options.kind,
    initiatedBy: options.initiatedBy ?? "mcp_app",
    review,
    state: "completed",
    completedAt,
    result: {
      outcome: options.kind === "add" ? "selection_added" : "selection_removed",
      selectionSetRevision: Buffer.alloc(16, 5).toString("base64url"),
      selection: {
        selection: completedSelection,
        historicalInspection: options.kind === "add" ? inspection : null,
      },
    },
  });
};
