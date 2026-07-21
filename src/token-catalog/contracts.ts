import { z } from "zod";

import {
  canonicalSha256,
  captureCanonicalJson,
  coreContractVersion,
  deepFreezeValue,
  defineReadCapability,
  getCapabilityDefinitionSnapshot,
  type CanonicalJson,
  type ConclusionDraft,
  type FactOutcome,
  type FactRequirement,
  type ObservationExpectation,
  type ObservationSlot,
  type ObservedFact,
} from "../core/index.js";
import { tokenCatalogErrorDefinitions } from "./error-definitions.js";
import {
  tokenCatalogApplicationContractList,
  tokenCatalogDigestVersions,
  tokenCatalogOperationConfirmationContract,
  tokenInspectCapabilityId,
  tokenInspectionDataSchema,
  tokenInspectionInputSchema,
  tokenInspectionStaticScopeExclusions,
  type TokenInspectionData,
  type TokenInspectionInput,
} from "./contract-schema.js";
import {
  tokenCatalogOperationKinds,
  tokenCatalogOperationStates,
} from "./state.js";

export * from "./contract-schema.js";

const sourceSlot = (
  slotId: string,
  factId: string,
  purpose: string,
): ObservationSlot => ({ slotId, factId, purpose, kind: "source", sourceClass: "chain_rpc" });

const requirement = (
  factId: string,
  outcome: FactOutcome,
  slotId: string,
): FactRequirement => ({
  factId,
  outcome,
  observationSlotIds: [slotId],
  requiredObservationSlotIds: [slotId],
  minimumObservationCount: 1,
});

const conclusion = (
  id: string,
  factId: string,
  _facts: ReadonlyMap<string, ObservedFact>,
): ConclusionDraft => ({
  id,
  outcomeFactId: factId,
  evidenceFactIds: [factId],
  freshnessRuleId: "chain_anchor_exact",
});

const claim = (
  role: string,
  value: CanonicalJson,
  data: TokenInspectionData,
) => ({ role, value, asset: data.asset, chainAnchor: data.block });

const expectation = (slotId: string, claims: ObservationExpectation["claims"]): ObservationExpectation => ({
  slotId,
  claims,
});

const inspectionFailureCodes = Object.freeze([
  "internal_error",
  "invalid_input",
  "not_found",
  "rate_limited",
  "request_aborted",
  "result_too_large",
  "runtime_busy",
  "source_inconsistent",
  "source_unavailable",
  "token_total_supply_reverted",
]);

const optionalFactOutcome = (
  observation: TokenInspectionData["metadata"]["name"],
): FactOutcome => observation.status === "available" ? "observed" : "source_failed";

export const tokenInspectCapability = defineReadCapability<TokenInspectionInput, TokenInspectionData>({
  capabilityId: tokenInspectCapabilityId,
  inputSchema: tokenInspectionInputSchema,
  dataSchema: tokenInspectionDataSchema,
  failureCodes: inspectionFailureCodes,
  conclusionIds: [
    "decimals_observed",
    "name_observed",
    "runtime_code_observed",
    "symbol_observed",
    "total_supply_observed",
  ],
  observationSlots: () => [
    sourceSlot("block", "block", "token_inspection_block"),
    sourceSlot("decimals", "decimals", "token_decimals"),
    sourceSlot("name", "name", "token_name"),
    sourceSlot("rpc_chain_id", "rpc_chain_id", "chain_id"),
    sourceSlot("runtime_code", "runtime_code", "token_runtime_code"),
    sourceSlot("symbol", "symbol", "token_symbol"),
    sourceSlot("total_supply", "total_supply", "token_total_supply"),
  ],
  observationExpectations: (_input, data) => [
    expectation("block", [{
      role: "token_inspection_block",
      value: data.block as unknown as CanonicalJson,
      chainAnchor: data.block,
    }]),
    expectation("decimals", [claim(
      "token_decimals",
      data.totalSupply.decimals.status === "available"
        ? data.totalSupply.decimals.value
        : { status: "unavailable", reason: "missing" },
      data,
    )]),
    expectation("name", [claim(
      "token_name",
      data.metadata.name.status === "available"
        ? data.metadata.name.value
        : { status: "unavailable", reason: data.metadata.name.reason },
      data,
    )]),
    expectation("rpc_chain_id", [{
      role: "chain_id",
      value: data.asset.chainId,
      chainAnchor: data.block,
    }]),
    expectation("runtime_code", [claim("token_runtime_code", data.runtimeCode as unknown as CanonicalJson, data)]),
    expectation("symbol", [claim(
      "token_symbol",
      data.metadata.symbol.status === "available"
        ? data.metadata.symbol.value
        : { status: "unavailable", reason: data.metadata.symbol.reason },
      data,
    )]),
    expectation("total_supply", [claim("token_total_supply", data.totalSupply.raw, data)]),
  ],
  factRequirements: (_input, data) => [
    requirement("block", "observed", "block"),
    requirement(
      "decimals",
      data.totalSupply.decimals.status === "available" ? "observed" : "source_failed",
      "decimals",
    ),
    requirement("name", optionalFactOutcome(data.metadata.name), "name"),
    requirement("rpc_chain_id", "observed", "rpc_chain_id"),
    requirement("runtime_code", "observed", "runtime_code"),
    requirement("symbol", optionalFactOutcome(data.metadata.symbol), "symbol"),
    requirement("total_supply", "observed", "total_supply"),
  ],
  deriveConclusions: (_input, _data, facts) => [
    conclusion("decimals_observed", "decimals", facts),
    conclusion("name_observed", "name", facts),
    conclusion("runtime_code_observed", "runtime_code", facts),
    conclusion("symbol_observed", "symbol", facts),
    conclusion("total_supply_observed", "total_supply", facts),
  ],
  deriveWarnings: (_input, data) => {
    const unavailableMetadataFacts = [
      ...(data.metadata.name.status === "available" ? [] : ["name"]),
      ...(data.metadata.symbol.status === "available" ? [] : ["symbol"]),
    ];
    return [
      ...(data.totalSupply.decimals.status === "available"
        ? []
        : [{ code: "decimals_unavailable" as const, factIds: ["decimals"] }]),
      ...(unavailableMetadataFacts.length === 0
        ? []
        : [{ code: "partial_result" as const, factIds: unavailableMetadataFacts }]),
    ];
  },
  validateSuccess: (data, context) => {
    if (data.asset.chainId !== context.chainId) throw new TypeError("Token inspection chain scope mismatch.");
  },
  validateRequest: (input, data) => {
    if (input.asset.chainId !== data.asset.chainId || input.asset.address !== data.asset.address) {
      throw new TypeError("Token inspection target mismatch.");
    }
    if (input.block.kind === "number" && input.block.blockNumber !== data.block.blockNumber) {
      throw new TypeError("Token inspection block mismatch.");
    }
  },
  validateEvidence: (_input, data, context) => {
    const binding = (observationId: string, role: string) =>
      context.observationClaims.find((candidate) =>
        candidate.observationId === observationId && candidate.role === role);
    if (data.totalSupply.decimals.status === "not_observed") {
      throw new TypeError("Token inspection decimals evidence is absent.");
    }
    const decimalsId = data.totalSupply.decimals.status === "available"
      ? data.totalSupply.decimals.observationId
      : data.totalSupply.decimals.observationIds[0];
    if (
      binding(data.totalSupply.quantityObservationId, "token_total_supply")?.value !== data.totalSupply.raw ||
      decimalsId === undefined || binding(decimalsId, "token_decimals") === undefined ||
      binding(data.metadata.name.observationId, "token_name") === undefined ||
      binding(data.metadata.symbol.observationId, "token_symbol") === undefined
    ) throw new TypeError("Token inspection evidence binding is incomplete.");
  },
  warningCodes: ["decimals_unavailable", "partial_result"],
  staticScopeExclusions: tokenInspectionStaticScopeExclusions,
});


export const tokenCatalogCapabilityIds = Object.freeze([
  getCapabilityDefinitionSnapshot(tokenInspectCapability).capabilityId,
  ...tokenCatalogApplicationContractList.map((contract) => contract.capabilityId),
].sort());

export const tokenCatalogContractProjection = deepFreezeValue({
  contractVersion: coreContractVersion,
  inspection: getCapabilityDefinitionSnapshot(tokenInspectCapability),
  applications: tokenCatalogApplicationContractList.map((contract) => ({
    capabilityId: contract.capabilityId,
    contractVersion: contract.contractVersion,
    inputSchema: captureCanonicalJson(JSON.parse(JSON.stringify(z.toJSONSchema(contract.inputSchema, {
      target: "draft-2020-12",
      unrepresentable: "throw",
      io: "input",
    })))),
    successSchema: captureCanonicalJson(JSON.parse(JSON.stringify(z.toJSONSchema(contract.successSchema, {
      target: "draft-2020-12",
      unrepresentable: "throw",
      io: "output",
    })))),
    failureCodes: contract.failureCodes,
  })),
  operationConfirmation: {
    contractVersion: tokenCatalogOperationConfirmationContract.contractVersion,
    inputSchema: captureCanonicalJson(JSON.parse(JSON.stringify(z.toJSONSchema(
      tokenCatalogOperationConfirmationContract.inputSchema,
      { target: "draft-2020-12", unrepresentable: "throw", io: "input" },
    )))),
    successSchema: captureCanonicalJson(JSON.parse(JSON.stringify(z.toJSONSchema(
      tokenCatalogOperationConfirmationContract.successSchema,
      { target: "draft-2020-12", unrepresentable: "throw", io: "output" },
    )))),
    failureCodes: tokenCatalogOperationConfirmationContract.failureCodes,
  },
  errors: tokenCatalogErrorDefinitions,
  operationKinds: tokenCatalogOperationKinds,
  operationStates: tokenCatalogOperationStates,
  digestVersions: tokenCatalogDigestVersions,
});

export const tokenCatalogContractProjectionDigest = `0x${canonicalSha256(
  tokenCatalogContractProjection as unknown as CanonicalJson,
)}`;
