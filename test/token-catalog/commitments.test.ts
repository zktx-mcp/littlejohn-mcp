import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  tokenInspectionDigest,
  tokenSelectionReviewDigest,
} from "../../src/token-catalog/contract-schema.js";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const independentCanonicalJson = (value: Json): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  const object = value as { readonly [key: string]: Json };
  return `{${Object.keys(object).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((key) => `${JSON.stringify(key)}:${independentCanonicalJson(object[key] as Json)}`).join(",")}}`;
};

const independentSha256 = (value: Json): string =>
  `0x${createHash("sha256").update(independentCanonicalJson(value), "utf8").digest("hex")}`;

const independentRecordDigest = (
  source: Json,
  claims: readonly Json[],
): string =>
  createHash("sha256").update(independentCanonicalJson({
    claims,
    digestKind: "evidence_source_record",
    source,
  }), "utf8").digest("base64url");

const independentObservationId = (
  sourceId: string,
  purpose: string,
  ordinal: string,
): string => `obs:${createHash("sha256").update(independentCanonicalJson([
  sourceId,
  purpose,
  evaluatedAt,
  block,
  invocationId,
  ordinal,
]), "utf8").digest("base64url")}`;

const chainId = "eip155:4663";
const asset = {
  kind: "erc20",
  chainId,
  address: "0x1212121212121212121212121212121212121212",
} as const;
const account = {
  chainId,
  address: "0x3434343434343434343434343434343434343434",
} as const;
const block = {
  chainId,
  blockNumber: "42",
  blockHash: "0xabababababababababababababababababababababababababababababababab",
  blockTimestamp: "2026-07-18T00:00:00.000Z",
} as const;
const evaluatedAt = "2026-07-18T00:00:02.000Z";
const invocationId = "inv:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const configurationDigest = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const sourceReference = {
  kind: "configured_rpc",
  sourceId: `rpc:${configurationDigest}`,
  publicOrigin: "https://rpc.example",
  configurationDigest,
} as const;
const sourceVerificationReference = {
  kind: "public",
  sourceId: "sourcify-v2",
  uri: `https://sourcify.example/contract/${asset.address}`,
} as const;
const observationIds = {
  decimals: "obs:KjVdvtRZIJy3zwHA7Otc5wCEv_RCinW1N7dbJRfdlhU",
  deployment: "obs:hWfkMakSUe8KgiSHDs3WKlLSL6W1awVPlEPIxSWwTlM",
  erc165: "obs:R-ohg6-LjbuT3Yk8BbJ1D9VtbBVJsmnUSKzINsaXloM",
  erc20ReadSurface: "obs:CF853c2caLAm--YtUsXNL7p2YCjyYHoV00yngnAGOfk",
  name: "obs:BNFneuqTJMHZ1m-uaj2idKCQDFvWtFcBPdCvvW-WK0E",
  rpcChainId: "obs:zHDbjtsuyiSFjUWZZPSi9CAHJlAwRMP3mKWiOtc7eeU",
  symbol: "obs:i02ZI2JnPdx5FzUropgVeHtNXLdlZ7t1aQN0yMpkFiQ",
  targetSource: "obs:eGbnBLdPYHAGbLcR4Fcd5CdsIAQhMaOY-LPo2FAVRTY",
  totalSupply: "obs:NrlK_XIOATGCNUGv1tLrwzX3dDBG8suvWtoss0XQOhE",
} as const;

const source = (
  observationId: string,
  purpose: string,
  claims: readonly Json[],
  authority: Readonly<{
    sourceClass: "chain_rpc" | "contract_verification_service";
    owner: string;
    reference: Json;
  }> = {
    sourceClass: "chain_rpc",
    owner: "user_configured",
    reference: sourceReference,
  },
) => {
  const sourceRecord = {
  observationId,
  invocationId,
  sourceClass: authority.sourceClass,
  owner: authority.owner,
  purpose,
  observedAt: evaluatedAt,
  reference: authority.reference,
  chainAnchor: block,
  } as const;
  return {
    ...sourceRecord,
    recordDigest: independentRecordDigest(sourceRecord, claims),
  };
};

const conclusion = (
  id: string,
  observationId: string,
) => ({
  id,
  status: "established",
  reason: "observed",
  observationIds: [observationId],
  freshness: {
    status: "fresh",
    ruleId: "chain_anchor_exact",
    evaluatedAt,
    observationIds: [observationId],
  },
});

const unavailableConclusion = (
  id: string,
  observationId: string,
  reason: "not_observed" | "source_failed" = "source_failed",
) => ({
  id,
  status: "unavailable",
  reason,
  observationIds: [observationId],
  freshness: {
    status: "fresh",
    ruleId: "contract_source_at_chain_anchor",
    evaluatedAt,
    observationIds: [observationId],
  },
});

const unsupportedConclusion = (
  id: string,
  observationId: string,
) => ({
  id,
  status: "not_applicable",
  reason: "unsupported",
  observationIds: [observationId],
  freshness: {
    status: "fresh",
    ruleId: "chain_anchor_exact",
    evaluatedAt,
    observationIds: [observationId],
  },
});

const runtimeCode = {
  byteLength: "2",
  codeHash: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
} as const;
const unavailableControls = {
  owner: { status: "unavailable", reason: "exact_abi_unavailable" },
  paused: { status: "unavailable", reason: "exact_abi_unavailable" },
  defaultAdmins: { status: "unavailable", reason: "exact_abi_unavailable" },
} as const;
const analysis = {
  chainId,
  target: asset.address,
  block,
  targetRuntimeCode: runtimeCode,
  proxy: { status: "no_supported_proxy_observed" },
  sources: [{
    role: "target",
    address: asset.address,
    status: "no_record_observed",
  }],
  declaredFunctions: {
    status: "unavailable",
    reason: "exact_abi_unavailable",
  },
  controls: unavailableControls,
} as const;
const deploymentClaim = {
  chainId,
  target: asset.address,
  block,
  targetRuntimeCode: runtimeCode,
  proxy: analysis.proxy,
} as const;
const targetSourceClaim = {
  role: "target",
  address: asset.address,
  status: "no_record_observed",
  declaredFunctions: analysis.declaredFunctions,
  controls: unavailableControls,
} as const;

const inspection = {
  ok: true,
  meta: {
    capabilityId: "token.inspect",
    contractVersion: "1",
    chainId,
    evaluatedAt,
  },
  data: {
    asset,
    analysis,
    totalSupply: {
      asset,
      raw: "1000000",
      decimals: {
        status: "available",
        value: "18",
        observationId: observationIds.decimals,
      },
      quantityObservationId: observationIds.totalSupply,
    },
    metadata: {
      name: {
        status: "available",
        value: "Example Token",
        observationId: observationIds.name,
      },
      symbol: {
        status: "available",
        value: "EXT",
        observationId: observationIds.symbol,
      },
      decimalsReadFailure: null,
    },
    standards: {
      asset,
      block,
      standards: [
        { standardId: "erc20_read_surface", status: "observed" },
        { standardId: "erc165", status: "not_supported" },
        { standardId: "erc8056", status: "unknown" },
        { standardId: "erc8056_pending_multiplier", status: "unknown" },
        { standardId: "erc8056_conversion", status: "unknown" },
        { standardId: "erc8056_balances", status: "unknown" },
      ],
    },
  },
  evidence: {
    sources: [
      source(observationIds.name, "token_name", [{
        asset,
        chainAnchor: block,
        role: "token_name",
        value: "Example Token",
      }]),
      source(observationIds.erc20ReadSurface, "erc20_read_surface", [{
        asset,
        chainAnchor: block,
        role: "erc20_read_surface",
        value: { standardId: "erc20_read_surface", status: "observed" },
      }]),
      source(observationIds.decimals, "token_decimals", [{
        asset,
        chainAnchor: block,
        role: "token_decimals",
        value: "18",
      }]),
      source(observationIds.totalSupply, "token_total_supply", [{
        asset,
        chainAnchor: block,
        role: "token_total_supply",
        value: "1000000",
      }]),
      source(observationIds.erc165, "erc165_status", [{
        asset,
        chainAnchor: block,
        role: "erc165_status",
        value: { standardId: "erc165", status: "not_supported" },
      }]),
      source(observationIds.targetSource, "contract_source_target", [{
        chainAnchor: block,
        role: "contract_source_target",
        value: targetSourceClaim,
      }], {
        sourceClass: "contract_verification_service",
        owner: "Sourcify",
        reference: sourceVerificationReference,
      }),
      source(observationIds.deployment, "contract_deployment", [{
        chainAnchor: block,
        role: "contract_deployment",
        value: deploymentClaim,
      }]),
      source(observationIds.symbol, "token_symbol", [{
        asset,
        chainAnchor: block,
        role: "token_symbol",
        value: "EXT",
      }]),
      source(observationIds.rpcChainId, "chain_id", [{
        chainAnchor: block,
        role: "chain_id",
        value: chainId,
      }]),
    ],
    conclusions: [
      unavailableConclusion(
        "contract_controls_observed",
        observationIds.targetSource,
        "not_observed",
      ),
      conclusion("contract_deployment_observed", observationIds.deployment),
      unavailableConclusion("contract_source_checked", observationIds.targetSource),
      conclusion("decimals_observed", observationIds.decimals),
      conclusion("erc165_status_observed", observationIds.erc165),
      conclusion("erc20_read_surface_observed", observationIds.erc20ReadSurface),
      unsupportedConclusion("erc8056_balances_status_observed", observationIds.erc165),
      unsupportedConclusion("erc8056_conversion_status_observed", observationIds.erc165),
      unsupportedConclusion("erc8056_pending_multiplier_status_observed", observationIds.erc165),
      unsupportedConclusion("erc8056_required_values_observed", observationIds.erc165),
      unsupportedConclusion("erc8056_status_observed", observationIds.erc165),
      conclusion("name_observed", observationIds.name),
      conclusion("symbol_observed", observationIds.symbol),
      conclusion("total_supply_observed", observationIds.totalSupply),
    ],
    coverage: {
      status: "partial",
      established: [
        "contract_deployment_observed",
        "decimals_observed",
        "erc165_status_observed",
        "erc20_read_surface_observed",
        "name_observed",
        "symbol_observed",
        "total_supply_observed",
      ],
      notApplicable: [
        "erc8056_balances_status_observed",
        "erc8056_conversion_status_observed",
        "erc8056_pending_multiplier_status_observed",
        "erc8056_required_values_observed",
        "erc8056_status_observed",
      ],
      unavailable: ["contract_controls_observed", "contract_source_checked"],
    },
  },
  warnings: [{
    code: "partial_result",
    message: "Some requested results are unavailable.",
    observationIds: [observationIds.targetSource],
  }],
} as const;

const additionReview = {
  contractVersion: "1",
  domain: "token_selection",
  operationId: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  kind: "add",
  createdAt: "2026-07-18T00:00:03.000Z",
  actionExpiresAt: "2026-07-18T00:05:03.000Z",
  target: { asset },
  decision: {
    name: { status: "available", value: inspection.data.metadata.name.value },
    symbol: { status: "available", value: inspection.data.metadata.symbol.value },
    officialClassification: "official",
    warningCodes: [],
  },
  precondition: {
    account,
    connectionRevision: "1",
    previousSelection: null,
    selectionSetRevision: null,
  },
  fixedEvidence: {
    inspectionBlock: block,
    officialSnapshotRevision: "BAQEBAQEBAQEBAQEBAQEBA",
    officialEvidence: {
      assetUid: "0x5656565656565656565656565656565656565656565656565656565656565656",
      snapshotRevision: "BAQEBAQEBAQEBAQEBAQEBA",
      verificationBlock: block,
    },
  },
} as const;

const previousSelection = {
  account,
  asset,
  included: true,
  revision: "AQEBAQEBAQEBAQEBAQEBAQ",
  createdAt: "2026-07-18T00:00:01.000Z",
  updatedAt: "2026-07-18T00:00:01.000Z",
} as const;

const removalReview = {
  contractVersion: "1",
  domain: "token_selection",
  operationId: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  kind: "remove",
  createdAt: "2026-07-18T00:00:03.000Z",
  actionExpiresAt: "2026-07-18T00:05:03.000Z",
  target: { asset },
  decision: { action: "remove_selection" },
  precondition: {
    account,
    connectionRevision: "1",
    previousSelection,
    selectionSetRevision: "AwMDAwMDAwMDAwMDAwMDAw",
  },
  fixedEvidence: {},
} as const;

describe("token commitment independent vectors", () => {
  it("fixes the complete inspection preimage without a production encoder or version owner", () => {
    expect(observationIds).toEqual({
      decimals: independentObservationId(sourceReference.sourceId, "token_decimals", "0"),
      deployment: independentObservationId(sourceReference.sourceId, "contract_deployment", "3"),
      erc165: independentObservationId(sourceReference.sourceId, "erc165_status", "10"),
      erc20ReadSurface: independentObservationId(sourceReference.sourceId, "erc20_read_surface", "9"),
      name: independentObservationId(sourceReference.sourceId, "token_name", "1"),
      rpcChainId: independentObservationId(sourceReference.sourceId, "chain_id", "2"),
      symbol: independentObservationId(sourceReference.sourceId, "token_symbol", "7"),
      targetSource: independentObservationId(
        sourceVerificationReference.sourceId,
        "contract_source_target",
        "5",
      ),
      totalSupply: independentObservationId(
        sourceReference.sourceId,
        "token_total_supply",
        "8",
      ),
    });
    const preimage = {
      digestKind: "token_inspection",
      digestVersion: "1",
      result: inspection,
    } as const;
    const expected = "0x9148634cb0f5f2bc0d09dcf4ed056dab9c7fd5c763d18d712d55d15bb1b9f924";
    expect(independentSha256(preimage)).toBe(expected);
    expect(tokenInspectionDigest(inspection)).toBe(expected);
  });

  it("fixes the exact official-addition preimage without a global contract version", () => {
    const preimage = {
      digestKind: "token_selection_change_review",
      digestVersion: "1",
      review: additionReview,
    } as const;
    const expected = "0x83531215302171c478b25769c5ddbb00c80c4561cae3248d499481f4f8e1f8cf";
    expect(independentSha256(preimage)).toBe(expected);
    expect(tokenSelectionReviewDigest(additionReview)).toBe(expected);
  });

  it("fixes the exact removal preimage without a global contract version", () => {
    const preimage = {
      digestKind: "token_selection_change_review",
      digestVersion: "1",
      review: removalReview,
    } as const;
    const expected = "0x8cc7a414ccaa6e1a4120962114130cdf6d0525e3a471dfacb7d75f50dca90d61";
    expect(independentSha256(preimage)).toBe(expected);
    expect(tokenSelectionReviewDigest(removalReview)).toBe(expected);
  });
});
