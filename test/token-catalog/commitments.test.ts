import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  tokenCatalogReviewDigest,
  tokenInspectionDigest,
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
const observationIds = {
  block: "obs:7akp-rwGZAogHyDDsTluzS5vsDv-o38cNZYqaRR0UVM",
  decimals: "obs:tZolIA-dsvYqp8jCSLNILtjDbG5rzmRgCU8Qud-1SPU",
  name: "obs:Ly6fdMj3RPYTMqzoXLRlhUfhZtzq2qgidU1cTKcAV9g",
  rpcChainId: "obs:2hb2nD1C6HdQrYxqapU-6Is4bhvgXZLt0uv0j80cIOw",
  runtimeCode: "obs:jU6_aPbZ-FDEuxDyEw34iAoJ_CTRZGfjKvIxUQ2Dzqc",
  symbol: "obs:aCciZ6NS574fhogzLZRapksN_3GG66EtXlI_z7fqcFU",
  totalSupply: "obs:3XLffN4EIF_cfanOZ_GOBFCItq5rL02AD_ON3RqWwL4",
} as const;

const source = (
  observationId: string,
  purpose: string,
) => ({
  observationId,
  invocationId,
  sourceClass: "chain_rpc",
  owner: "user_configured",
  purpose,
  observedAt: evaluatedAt,
  reference: sourceReference,
  chainAnchor: block,
});

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

const inspection = {
  ok: true,
  meta: {
    capabilityId: "token.inspect",
    contractVersion: "7",
    chainId,
    evaluatedAt,
  },
  data: {
    asset,
    block,
    runtimeCode: {
      byteLength: "2",
      codeHash: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    },
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
      source(observationIds.rpcChainId, "chain_id"),
      source(observationIds.totalSupply, "token_total_supply"),
      source(observationIds.block, "token_inspection_block"),
      source(observationIds.name, "token_name"),
      source(observationIds.symbol, "token_symbol"),
      source(observationIds.runtimeCode, "token_runtime_code"),
      source(observationIds.decimals, "token_decimals"),
    ],
    conclusions: [
      conclusion("decimals_observed", observationIds.decimals),
      conclusion("name_observed", observationIds.name),
      conclusion("runtime_code_observed", observationIds.runtimeCode),
      conclusion("symbol_observed", observationIds.symbol),
      conclusion("total_supply_observed", observationIds.totalSupply),
    ],
    coverage: {
      status: "complete",
      established: [
        "decimals_observed",
        "name_observed",
        "runtime_code_observed",
        "symbol_observed",
        "total_supply_observed",
      ],
      notApplicable: [],
      unavailable: [],
    },
  },
  warnings: [],
} as const;

const additionReview = {
  operationId: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  kind: "add",
  account,
  connectionRevision: "1",
  asset,
  previousSelection: null,
  selectionSetRevision: null,
  inspection,
  officialSnapshotRevision: "BAQEBAQEBAQEBAQEBAQEBA",
  officialEvidence: {
    assetUid: "0x5656565656565656565656565656565656565656565656565656565656565656",
    snapshotRevision: "BAQEBAQEBAQEBAQEBAQEBA",
    verificationBlock: block,
  },
  interactionInterface: "web",
  expiresAt: "2026-07-18T00:05:03.000Z",
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
  operationId: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  kind: "remove",
  account,
  connectionRevision: "1",
  asset,
  previousSelection,
  selectionSetRevision: "AwMDAwMDAwMDAwMDAwMDAw",
  inspection: null,
  officialSnapshotRevision: null,
  officialEvidence: null,
  interactionInterface: "web",
  expiresAt: "2026-07-18T00:05:03.000Z",
} as const;

describe("token commitment independent vectors", () => {
  it("fixes the complete inspection preimage without a production encoder or version owner", () => {
    const preimage = {
      digestKind: "token_inspection",
      digestVersion: "2",
      result: inspection,
    } as const;
    const expected = "0xc375d94aed42f211328af631fdff8d609892d01113cb9b57297646314128a802";
    expect(independentSha256(preimage)).toBe(expected);
    expect(tokenInspectionDigest(inspection)).toBe(expected);
  });

  it("fixes the official-addition null branches and complete anchor", () => {
    const preimage = {
      digestKind: "token_catalog_review",
      digestVersion: "3",
      coreContractVersion: "7",
      operationId: additionReview.operationId,
      operationKind: additionReview.kind,
      account,
      connectionRevision: additionReview.connectionRevision,
      asset,
      previousSelection: null,
      selectionSetRevision: null,
      inspection,
      officialSnapshotRevision: additionReview.officialSnapshotRevision,
      officialEvidence: additionReview.officialEvidence,
      interactionInterface: additionReview.interactionInterface,
      expiresAt: additionReview.expiresAt,
    } as const;
    const expected = "0x09a2c7d6b09d74a0ec614eddaa7ae2a527b13d6f55af9816343dc9bad6225267";
    expect(independentSha256(preimage)).toBe(expected);
    expect(tokenCatalogReviewDigest(additionReview)).toBe(expected);
  });

  it("fixes the removal non-null selection branches", () => {
    const preimage = {
      digestKind: "token_catalog_review",
      digestVersion: "3",
      coreContractVersion: "7",
      operationId: removalReview.operationId,
      operationKind: removalReview.kind,
      account,
      connectionRevision: removalReview.connectionRevision,
      asset,
      previousSelection,
      selectionSetRevision: removalReview.selectionSetRevision,
      inspection: null,
      officialSnapshotRevision: null,
      officialEvidence: null,
      interactionInterface: removalReview.interactionInterface,
      expiresAt: removalReview.expiresAt,
    } as const;
    const expected = "0x85d0364d15f8670737e860ee1899ebe56ece50ba0a98889580f514bb84ba3c84";
    expect(independentSha256(preimage)).toBe(expected);
    expect(tokenCatalogReviewDigest(removalReview)).toBe(expected);
  });
});
