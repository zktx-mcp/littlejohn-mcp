import { createHash } from "node:crypto";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  assertContractAnalysisForTarget,
  canonicalJsonStringify,
  captureCanonicalJson,
  chainAnchorSchema,
  contractAnalysisSchema,
  erc20AssetIdentitySchema,
  getCapabilityDefinitionSnapshot,
  parseCapabilitySuccess,
  parseHash32,
  parseUtcTimestamp,
  tokenStandardObservationResultSchema,
  type CanonicalJson,
} from "../../src/core/index.js";
import { internalResponseLimitBytes } from "../../src/runtime/http-limits.js";
import { officialAssetSnapshotRevisionSchema } from "../../src/registry/index.js";
import {
  createTokenAdditionReviewProjection,
  parseTokenSelectionReview,
  tokenCatalogApplicationContracts,
  tokenCatalogCapabilityIds,
  tokenCatalogContractLimits,
  tokenCatalogContractProjection,
  tokenCatalogContractProjectionDigest,
  tokenCatalogErrorDefinitions,
  tokenCatalogInterfaceErrorMappingDefinitions,
  tokenCatalogOperationIdSchema,
  tokenCatalogOperationSchema,
  tokenInspectCapability,
  tokenSelectionReviewDigest,
  tokenInspectionDataSchema,
  tokenInspectionInputSchema,
  tokenInspectionSuccessSchema,
  tokenOfficialSelectionEvidenceSchema,
  tokenSelectionDirectActionSchema,
  tokenSelectionRevisionSchema,
  tokenSelectionSchema,
  tokenSelectionSetRevisionSchema,
  type TokenCatalogOperation,
  type TokenCatalogOperationVariant,
  type TokenInspectionSuccess,
  type TokenSelection,
  type TokenSelectionReview,
} from "../../src/token-catalog/index.js";
import { createInspectionSuccess, createTokenOperation, walletAddress } from "./harness.js";
import {
  changeUnavailableOwnerReason,
  createExactResolvedAnalysis,
  reversedDeclaredFunctions,
  validContractAnalysisClaimMutations,
} from "../core/contract-analysis-fixtures.js";

const asset = erc20AssetIdentitySchema.parse({
  kind: "erc20",
  chainId: "eip155:4663",
  address: `0x${"12".repeat(20)}`,
});

const operationId = "A".repeat(43);
const revisionA = Buffer.alloc(16, 1).toString("base64url");
const snapshotRevision = officialAssetSnapshotRevisionSchema.parse(
  Buffer.alloc(16, 3).toString("base64url"),
);
const createdAt = parseUtcTimestamp("2026-07-18T00:00:03.000Z");
const actionExpiresAt = parseUtcTimestamp("2026-07-18T00:05:03.000Z");

const independentCanonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${independentCanonicalJson(entry)}`).join(",")}}`;
  }
  throw new TypeError("Unsupported test canonical JSON value.");
};

const canonicalOutputSchema = (schema: z.ZodType): string =>
  independentCanonicalJson(JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io: "output",
  }))) as CanonicalJson);

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const selectionFor = (
  inspection: TokenInspectionSuccess,
  revision = revisionA,
): TokenSelection => ({
  account: { chainId: inspection.data.asset.chainId, address: walletAddress },
  asset: inspection.data.asset,
  included: true,
  revision,
  createdAt,
  updatedAt: createdAt,
});

const selectionPageEntries = (count: number): readonly TokenSelection[] => {
  const chainId = `eip155:${"9".repeat(32)}`;
  const accountAddress = `0x${"f".repeat(40)}`;
  const timestamp = "9999-12-31T23:59:59.999Z";
  return Array.from({ length: count }, (_, index) => tokenSelectionSchema.parse({
    account: { chainId, address: accountAddress },
    asset: {
      kind: "erc20",
      chainId,
      address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    },
    included: index % 2 === 0,
    revision: Buffer.alloc(16, index + 1).toString("base64url"),
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
};

type AdditionReview = Extract<TokenSelectionReview, { readonly kind: "add" }>;

const additionReviewFor = (
  inspection: TokenInspectionSuccess,
  officialEvidence: AdditionReview["fixedEvidence"]["officialEvidence"] = null,
): AdditionReview => {
  const projection = officialEvidence === null
    ? createTokenAdditionReviewProjection({
        inspection,
        officialSnapshotRevision: snapshotRevision,
        officialMember: null,
        officialVerification: null,
      })
    : {
        decision: {
          name: inspection.data.metadata.name.status === "available"
            ? { status: "available" as const, value: inspection.data.metadata.name.value }
            : { status: "unavailable" as const, reason: inspection.data.metadata.name.reason },
          symbol: inspection.data.metadata.symbol.status === "available"
            ? { status: "available" as const, value: inspection.data.metadata.symbol.value }
            : { status: "unavailable" as const, reason: inspection.data.metadata.symbol.reason },
          officialClassification: "official" as const,
          warningCodes: [],
        },
        fixedEvidence: {
          inspectionBlock: inspection.data.analysis.block,
          officialSnapshotRevision: snapshotRevision,
          officialEvidence,
        },
      };
  const withoutDigest = {
    contractVersion: "1" as const,
    domain: "token_selection" as const,
    operationId,
    kind: "add" as const,
    createdAt,
    actionExpiresAt,
    target: { asset: inspection.data.asset },
    precondition: {
      account: { chainId: inspection.data.asset.chainId, address: walletAddress },
      connectionRevision: "1",
      previousSelection: null,
      selectionSetRevision: null,
    },
    ...projection,
  };
  return parseTokenSelectionReview({
    ...withoutDigest,
    reviewDigest: tokenSelectionReviewDigest(withoutDigest),
  }) as AdditionReview;
};

describe("token catalog contracts", () => {
  it("preserves the independent token inspection schema projections", () => {
    for (const [schema, expectedBytes, expectedDigest] of [
      [
        tokenInspectionDataSchema,
        15_163,
        "f562b1fc6173ca8bf9aba254bdcc26a49f3b4e3cff90d51b69a204d525e7bf0b",
      ],
      [
        tokenInspectionSuccessSchema,
        22_051,
        "3c63542a56086dc53bb4b4d4be1bfc4db22c3b2bee2051eac242d92acd203fdc",
      ],
    ] as const) {
      const canonical = canonicalOutputSchema(schema);
      expect(Buffer.byteLength(canonical, "utf8")).toBe(expectedBytes);
      expect(sha256(canonical)).toBe(expectedDigest);
    }
  });

  it("projects each token contract's initial owner version without a global authority", () => {
    const inspectionContract = getCapabilityDefinitionSnapshot(tokenInspectCapability);
    const applicationVersions = Object.fromEntries(
      Object.values(tokenCatalogApplicationContracts).map((contract) => [
        contract.capabilityId,
        contract.contractVersion,
      ]),
    );
    expect(inspectionContract).toMatchObject({
      capabilityId: "token.inspect",
      contractVersion: "1",
    });
    expect(tokenCatalogCapabilityIds).toEqual([
      "token.add_selection",
      "token.inspect",
      "token.operation",
      "token.remove_selection",
      "token.selection",
      "token.selection_change_review",
      "token.selections",
    ]);
    expect(applicationVersions).toEqual({
      "token.add_selection": "1",
      "token.operation": "1",
      "token.remove_selection": "1",
      "token.selection": "1",
      "token.selection_change_review": "1",
      "token.selections": "1",
    });
    expect(tokenCatalogContractProjection.contractVersion).toBe("1");
    expect(tokenCatalogContractProjection.inspection).toEqual(inspectionContract);
    expect(Object.fromEntries(tokenCatalogContractProjection.applications.map((contract) => [
      contract.capabilityId,
      contract.contractVersion,
    ]))).toEqual(applicationVersions);
    expect(tokenCatalogContractProjection.initiators).toEqual(["cli", "mcp_app"]);
    expect(tokenCatalogContractProjection.operationKinds).toEqual(["add", "remove"]);
    expect(tokenCatalogContractProjection.operationStates).toEqual(["completed"]);
    expect(tokenCatalogContractProjection.digestVersions).toEqual({
      inspection: "1",
      review: "1",
    });
    expect(tokenCatalogContractProjectionDigest).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(Object.isFrozen(tokenCatalogContractProjection)).toBe(true);
    expect(tokenCatalogErrorDefinitions).toContainEqual({
      code: "token_total_supply_reverted",
      category: "domain",
      message: "The token contract reverted the required totalSupply call.",
      retryable: false,
    });
    expect(tokenCatalogInterfaceErrorMappingDefinitions).toContainEqual({
      code: "token_total_supply_reverted",
      httpStatus: 422,
      problemTitle: "Token total supply reverted",
      cliExitCode: 3,
    });
    expect(getCapabilityDefinitionSnapshot(tokenInspectCapability).failureCodes)
      .toContain("token_total_supply_reverted");
    expect(tokenCatalogApplicationContracts.addSelection.failureCodes)
      .toContain("token_total_supply_reverted");
    expect(tokenCatalogErrorDefinitions).toEqual(expect.arrayContaining([
      {
        code: "official_asset_response_unavailable",
        category: "transport",
        message: "A complete official asset response was not obtained.",
        retryable: true,
      },
      {
        code: "official_asset_response_too_large",
        category: "domain",
        message: "The official asset response exceeds the supported size.",
        retryable: false,
      },
      {
        code: "factory_identity_mismatch",
        category: "source",
        message: "The StockFactory deployment identity did not match the admitted identity.",
        retryable: false,
      },
      {
        code: "token_code_missing",
        category: "source",
        message: "No runtime code was found at the mapped token address.",
        retryable: false,
      },
      {
        code: "token_identity_mismatch",
        category: "source",
        message: "The StockFactory UID mapping did not match the official token address.",
        retryable: false,
      },
    ]));
    expect(tokenCatalogApplicationContracts.addSelection.failureCodes).toEqual(
      expect.arrayContaining([
        "factory_identity_mismatch",
        "token_code_missing",
        "token_identity_mismatch",
      ]),
    );
  });

  it("keeps inspection input and application input objects strict", () => {
    expect(tokenInspectionInputSchema.parse({ asset, block: { kind: "latest" } })).toEqual({
      asset,
      block: { kind: "latest" },
    });
    expect(() => tokenInspectionInputSchema.parse({
      asset,
      block: { kind: "latest" },
      profileId: "caller-owned",
    })).toThrow();
    expect(() => tokenCatalogApplicationContracts.selection.parseInput({
      asset,
      walletAddress: `0x${"34".repeat(20)}`,
    })).toThrow();
  });

  it("binds public token data references to their definition-owned source slots", async () => {
    const inspection = await createInspectionSuccess();
    const input = { asset, block: { kind: "latest" as const } };
    expect(() => parseCapabilitySuccess(tokenInspectCapability, input, inspection)).not.toThrow();
    expect(inspection.evidence.sources.every((source) =>
      /^[A-Za-z0-9_-]{43}$/u.test(source.recordDigest))).toBe(true);

    const deploymentSource = inspection.evidence.sources.find(
      (source) => source.purpose === "contract_deployment",
    );
    expect(deploymentSource).toBeDefined();
    if (deploymentSource === undefined) return;
    expect(() => parseCapabilitySuccess(tokenInspectCapability, input, {
      ...inspection,
      data: {
        ...inspection.data,
        totalSupply: {
          ...inspection.data.totalSupply,
          quantityObservationId: deploymentSource.observationId,
        },
      },
    })).toThrow();
    expect(inspection.data.metadata.symbol.status).toBe("available");
    if (inspection.data.metadata.symbol.status !== "available") return;
    expect(() => parseCapabilitySuccess(tokenInspectCapability, input, {
      ...inspection,
      data: {
        ...inspection.data,
        metadata: {
          ...inspection.data.metadata,
          symbol: {
            ...inspection.data.metadata.symbol,
            value: "ALT",
          },
        },
      },
    })).toThrow("record");
    for (const source of inspection.evidence.sources) {
      expect(() => parseCapabilitySuccess(tokenInspectCapability, input, {
        ...inspection,
        evidence: {
          ...inspection.evidence,
          sources: inspection.evidence.sources.map((candidate) => candidate === source
            ? { ...candidate, recordDigest: "A".repeat(43) as typeof candidate.recordDigest }
            : candidate),
        },
      })).toThrow();
    }
  });

  it("derives complete standard evidence from fixed members without synthetic sources", async () => {
    const inspection = await createInspectionSuccess();
    expect(inspection.evidence.conclusions.find(
      ({ id }) => id === "erc20_read_surface_observed",
    )).toMatchObject({
      status: "established",
      reason: "observed",
    });
    expect(inspection.evidence.conclusions.find(
      ({ id }) => id === "erc165_status_observed",
    )).toMatchObject({
      status: "established",
      reason: "observed",
    });
    for (const conclusionId of [
      "erc8056_status_observed",
      "erc8056_pending_multiplier_status_observed",
      "erc8056_conversion_status_observed",
      "erc8056_balances_status_observed",
      "erc8056_required_values_observed",
    ]) {
      expect(inspection.evidence.conclusions.find(({ id }) => id === conclusionId)).toMatchObject({
        status: "not_applicable",
        reason: "unsupported",
      });
    }
    expect(inspection.evidence.sources.filter((source) =>
      source.purpose.endsWith("_status") || source.purpose === "erc8056_required_values",
    ).map((source) => source.purpose)).toEqual(["erc165_status"]);
  });

  it("keeps unavailable standards explicit and rejects changed standard claims", async () => {
    const base = await createInspectionSuccess();
    const unavailableStandards = tokenStandardObservationResultSchema.parse({
      asset,
      block: base.data.analysis.block,
      standards: [
        { standardId: "erc20_read_surface", status: "observed" },
        { standardId: "erc165", status: "inconsistent" },
        { standardId: "erc8056", status: "unknown" },
        { standardId: "erc8056_pending_multiplier", status: "unknown" },
        { standardId: "erc8056_conversion", status: "unknown" },
        { standardId: "erc8056_balances", status: "unknown" },
      ],
    });
    const unavailable = await createInspectionSuccess(undefined, {
      standards: unavailableStandards,
    });
    expect(unavailable.evidence.conclusions.find(
      ({ id }) => id === "erc165_status_observed",
    )).toMatchObject({
      status: "unavailable",
      reason: "source_inconsistent",
    });
    expect(unavailable.evidence.conclusions.find(
      ({ id }) => id === "erc8056_status_observed",
    )).toMatchObject({
      status: "unavailable",
      reason: "not_observed",
    });
    expect(unavailable.evidence.sources.some((source) =>
      source.purpose === "erc8056_status")).toBe(false);

    const supportedStandards = tokenStandardObservationResultSchema.parse({
      asset,
      block: base.data.analysis.block,
      standards: [
        { standardId: "erc20_read_surface", status: "observed" },
        { standardId: "erc165", status: "supported" },
        { standardId: "erc8056", status: "supported" },
        { standardId: "erc8056_pending_multiplier", status: "supported" },
        { standardId: "erc8056_conversion", status: "not_supported" },
        { standardId: "erc8056_balances", status: "not_supported" },
      ],
      requiredErc8056: {
        currentMultiplier: "2",
        pendingMultiplier: "3",
        pendingEffectiveAt: "4",
      },
    });
    const supported = await createInspectionSuccess(undefined, { standards: supportedStandards });
    expect(supported.evidence.conclusions.filter((entry) =>
      entry.id.startsWith("erc") && entry.status === "established")).toHaveLength(7);

    const changedStatus = structuredClone(supported);
    changedStatus.data.standards.standards[4] = {
      standardId: "erc8056_conversion",
      status: "supported",
    };
    expect(() => parseCapabilitySuccess(
      tokenInspectCapability,
      { asset, block: { kind: "latest" } },
      changedStatus,
    )).toThrow();

    const changedValue = structuredClone(supported);
    if (changedValue.data.standards.requiredErc8056 === undefined) {
      throw new TypeError("Expected required ERC-8056 values.");
    }
    changedValue.data.standards.requiredErc8056.currentMultiplier =
      "5" as typeof changedValue.data.standards.requiredErc8056.currentMultiplier;
    expect(() => parseCapabilitySuccess(
      tokenInspectCapability,
      { asset, block: { kind: "latest" } },
      changedValue,
    )).toThrow();
  });

  it("admits only the closed decimals read-failure and numeric-state relation", async () => {
    const inspection = await createInspectionSuccess();
    expect(() => tokenInspectionDataSchema.parse({
      ...inspection.data,
      metadata: { ...inspection.data.metadata, decimalsReadFailure: "call_failed" },
    })).toThrow();
    expect(() => tokenInspectionDataSchema.parse({
      ...inspection.data,
      totalSupply: {
        ...inspection.data.totalSupply,
        decimals: {
          status: "unavailable",
          reason: "missing",
          observationIds: [inspection.data.totalSupply.decimals.status === "available"
            ? inspection.data.totalSupply.decimals.observationId
            : inspection.data.totalSupply.quantityObservationId],
        },
      },
    })).toThrow();
  });

  it("rejects every token-analysis claim change while retaining the original evidence", async () => {
    const input = { asset, block: { kind: "latest" as const } };
    const analysisBlock = chainAnchorSchema.parse({
      chainId: asset.chainId,
      blockNumber: "42",
      blockHash: `0x${"ab".repeat(32)}`,
      blockTimestamp: "2026-07-18T00:00:00.000Z",
    });
    const originalAnalysis = createExactResolvedAnalysis(asset.address, analysisBlock);
    const original = await createInspectionSuccess(input, { analysis: originalAnalysis });
    const exactAbsentAnalysis = contractAnalysisSchema.parse({
      chainId: asset.chainId,
      target: asset.address,
      block: analysisBlock,
      targetRuntimeCode: originalAnalysis.targetRuntimeCode,
      proxy: { status: "no_supported_proxy_observed" },
      sources: [{ role: "target", address: asset.address, status: "exact_match" }],
      declaredFunctions: { status: "observed", signatures: [] },
      controls: {
        owner: { status: "not_declared" },
        paused: { status: "not_declared" },
        defaultAdmins: { status: "not_declared" },
      },
    });
    const exactAbsent = await createInspectionSuccess(input, { analysis: exactAbsentAnalysis });
    const unavailableSource = await createInspectionSuccess(input);
    for (const [inspection, expected] of [
      [original, { status: "established", reason: "observed" }],
      [exactAbsent, { status: "not_applicable", reason: "not_present" }],
      [unavailableSource, { status: "unavailable", reason: "not_observed" }],
    ] as const) {
      expect(inspection.evidence.conclusions.find(
        ({ id }) => id === "contract_controls_observed",
      )).toMatchObject(expected);
    }
    const target = {
      chainId: asset.chainId,
      address: asset.address,
      block: analysisBlock,
      runtimeCode: originalAnalysis.targetRuntimeCode,
    };
    for (const mutation of validContractAnalysisClaimMutations(originalAnalysis)) {
      expect(() => assertContractAnalysisForTarget(target, mutation.analysis), mutation.label)
        .not.toThrow();
      expect(() => parseCapabilitySuccess(tokenInspectCapability, input, {
        ...original,
        data: { ...original.data, analysis: mutation.analysis },
      }), mutation.label).toThrow();
    }

    const changedOwner = validContractAnalysisClaimMutations(originalAnalysis).find(
      (mutation) => mutation.label === "owner",
    )?.analysis;
    expect(changedOwner).toBeDefined();
    if (changedOwner === undefined) return;
    const changedInspection = {
      ...original,
      data: { ...original.data, analysis: changedOwner },
    };
    const review = additionReviewFor(original);
    expect(() => parseTokenSelectionReview({
      ...review,
      decision: {
        ...review.decision,
        name: review.decision.name.status === "available"
          ? { ...review.decision.name, value: `${review.decision.name.value} changed` }
          : changedInspection.data.metadata.name,
      },
    }), "Review digest").toThrow();

    expect(() => parseCapabilitySuccess(tokenInspectCapability, input, {
      ...original,
      data: {
        ...original.data,
        analysis: reversedDeclaredFunctions(originalAnalysis),
      },
    }), "declared-function order").toThrow();

    const unavailableAnalysis = createExactResolvedAnalysis(asset.address, analysisBlock, {
      status: "unavailable",
      reason: "call_reverted",
    });
    const unavailable = await createInspectionSuccess(input, {
      analysis: unavailableAnalysis,
    });
    const changedReason = changeUnavailableOwnerReason(unavailableAnalysis);
    expect(() => assertContractAnalysisForTarget(target, changedReason)).not.toThrow();
    expect(() => parseCapabilitySuccess(tokenInspectCapability, input, {
      ...unavailable,
      data: { ...unavailable.data, analysis: changedReason },
    }), "unavailable reason").toThrow();
  });

  it("rejects every independent field mismatch in both token anchor relations", async () => {
    const inspection = await createInspectionSuccess();
    const anchorMutations = [
      { field: "chainId", value: "eip155:1" },
      { field: "blockNumber", value: "43" },
      { field: "blockHash", value: `0x${"cd".repeat(32)}` },
      { field: "blockTimestamp", value: "2026-07-18T00:00:01.000Z" },
    ] as const;

    for (const mutation of anchorMutations) {
      const invalidInspection = JSON.parse(JSON.stringify(inspection)) as {
        data: { standards: { block: Record<string, unknown> } };
      };
      invalidInspection.data.standards.block[mutation.field] = mutation.value;
      expect(() => tokenInspectionSuccessSchema.parse(invalidInspection)).toThrow();
    }

    const officialEvidence: NonNullable<
      AdditionReview["fixedEvidence"]["officialEvidence"]
    > = {
      assetUid: parseHash32(`0x${"56".repeat(32)}`),
      snapshotRevision,
      verificationBlock: inspection.data.analysis.block,
    };
    const review = additionReviewFor(inspection, officialEvidence);
    expect(() => parseTokenSelectionReview(review)).not.toThrow();

    for (const mutation of anchorMutations) {
      const fixedEvidence = {
        ...review.fixedEvidence,
        officialEvidence: {
          ...officialEvidence,
          verificationBlock: {
            ...officialEvidence.verificationBlock,
            [mutation.field]: mutation.value,
          },
        },
      };
      const { reviewDigest: _digest, ...base } = review;
      const mutated = { ...base, fixedEvidence };
      expect(() => parseTokenSelectionReview({
        ...mutated,
        reviewDigest: tokenSelectionReviewDigest(mutated),
      })).toThrow();
    }
  });

  it("normalizes only the declared list defaults and keeps selection input exact", () => {
    expect(tokenCatalogApplicationContracts.selections.parseInput({})).toEqual({
      limit: 25,
      cursor: null,
    });
    expect(tokenCatalogApplicationContracts.selections.parseInput({ limit: 25 })).toEqual({
      limit: 25,
      cursor: null,
    });
    expect(() => tokenCatalogApplicationContracts.selections.parseInput({ limit: 26 }))
      .toThrow();
    expect(tokenCatalogApplicationContracts.selectionChangeReview.parseInput({
      kind: "add",
      asset,
    })).toEqual({ kind: "add", asset });
    expect(() => tokenCatalogApplicationContracts.selectionChangeReview.parseInput({
      kind: "add",
      asset,
      settings: {},
    })).toThrow();
  });

  it("uses exact selection revision and operation identifier sizes", () => {
    expect(tokenCatalogContractLimits).toEqual({
      selectionRevisionBytes: 16,
      listDefaultLimit: 25,
      listMaximumLimit: 25,
      directActionUtf8Bytes: 32_768,
      reviewActionMilliseconds: 300_000,
    });
    for (const schema of [tokenSelectionRevisionSchema, tokenSelectionSetRevisionSchema]) {
      expect(schema.safeParse(Buffer.alloc(15).toString("base64url")).success).toBe(false);
      expect(schema.safeParse(Buffer.alloc(16).toString("base64url")).success).toBe(true);
      expect(schema.safeParse(Buffer.alloc(17).toString("base64url")).success).toBe(false);
    }
    expect(tokenCatalogOperationIdSchema.safeParse("A".repeat(43)).success).toBe(true);
    expect(tokenCatalogOperationIdSchema.safeParse("A".repeat(44)).success).toBe(false);
  });

  it("keeps the actual maximum selection page within the compatible-process response limit", () => {
    const selections = selectionPageEntries(25);
    const page = tokenCatalogApplicationContracts.selections.parsePublicSuccess(
      { limit: 25, cursor: null },
      { selections, nextCursor: null },
    );
    expect(Buffer.byteLength(`${canonicalJsonStringify(captureCanonicalJson(page))}\n`, "utf8"))
      .toBeLessThanOrEqual(internalResponseLimitBytes);
  });

  it("admits 25 selection results and rejects 26 independently of request correlation", () => {
    const schema = tokenCatalogApplicationContracts.selections.successSchema;
    expect(schema.safeParse({ selections: selectionPageEntries(25), nextCursor: null }).success)
      .toBe(true);
    expect(schema.safeParse({ selections: selectionPageEntries(26), nextCursor: null }).success)
      .toBe(false);
  });

  it("bounds the complete canonical direct action at 32,768 UTF-8 bytes", async () => {
    const inspection = await createInspectionSuccess();
    const baseReview = additionReviewFor(inspection);
    const actionForRevisionDigits = (digitCount: number) => {
      const { reviewDigest: _digest, ...withoutDigest } = baseReview;
      const candidate = {
        ...withoutDigest,
        precondition: {
          ...withoutDigest.precondition,
          connectionRevision: "1".repeat(digitCount),
        },
      };
      const review = parseTokenSelectionReview({
        ...candidate,
        reviewDigest: tokenSelectionReviewDigest(candidate),
      });
      const action = { review, initiatedBy: "mcp_app" as const };
      return {
        action,
        byteLength: Buffer.byteLength(
          canonicalJsonStringify(captureCanonicalJson(action)),
          "utf8",
        ),
      };
    };
    const baseline = actionForRevisionDigits(1);
    const exact = actionForRevisionDigits(1 + 32_768 - baseline.byteLength);
    const over = actionForRevisionDigits(2 + 32_768 - baseline.byteLength);
    expect(exact.byteLength).toBe(32_768);
    expect(over.byteLength).toBe(32_769);
    expect(tokenSelectionDirectActionSchema.parse(exact.action)).toEqual(exact.action);
    expect(() => tokenSelectionDirectActionSchema.parse(over.action)).toThrow("too large");
  });

  it("owns the exact 300,000 millisecond Review action lifetime", async () => {
    const inspection = await createInspectionSuccess();
    const baseReview = additionReviewFor(inspection);
    const reviewAtOffset = (offsetMilliseconds: number) => {
      const { reviewDigest: _digest, ...withoutDigest } = baseReview;
      const candidate = {
        ...withoutDigest,
        actionExpiresAt: new Date(
          Date.parse(withoutDigest.createdAt) + 300_000 + offsetMilliseconds,
        ).toISOString(),
      };
      return {
        ...candidate,
        reviewDigest: tokenSelectionReviewDigest(candidate),
      };
    };
    expect(() => parseTokenSelectionReview(reviewAtOffset(0))).not.toThrow();
    expect(() => parseTokenSelectionReview(reviewAtOffset(-1))).toThrow("inconsistent");
    expect(() => parseTokenSelectionReview(reviewAtOffset(1))).toThrow("inconsistent");
  });

  it("consumes the Official Asset revision contract in both Review fields", async () => {
    const inspection = await createInspectionSuccess();
    const exactRevision = Buffer.alloc(16, 3).toString("base64url");
    const officialEvidence = {
      assetUid: parseHash32(`0x${"56".repeat(32)}`),
      snapshotRevision: exactRevision,
      verificationBlock: inspection.data.analysis.block,
    };
    expect(() => tokenOfficialSelectionEvidenceSchema.parse(officialEvidence)).not.toThrow();
    const review = additionReviewFor(
      inspection,
      tokenOfficialSelectionEvidenceSchema.parse(officialEvidence),
    );
    const { reviewDigest: _digest, ...withoutDigest } = review;
    for (const byteLength of [15, 17]) {
      const revision = Buffer.alloc(byteLength, 3).toString("base64url");
      expect(() => tokenOfficialSelectionEvidenceSchema.parse({
        ...officialEvidence,
        snapshotRevision: revision,
      })).toThrow();
      expect(() => tokenSelectionReviewDigest({
        ...withoutDigest,
        fixedEvidence: {
          ...withoutDigest.fixedEvidence,
          officialSnapshotRevision: revision,
        },
      })).toThrow();
    }
  });

  it("rejects accessor, proxy, and additional-field inputs before authority use", () => {
    const accessor = Object.defineProperty({}, "asset", {
      enumerable: true,
      get: () => asset,
    });
    expect(() => tokenCatalogApplicationContracts.selection.parseInput(accessor)).toThrow();

    const proxied = new Proxy({ asset }, {
      ownKeys: () => { throw new Error("trap"); },
    });
    expect(() => tokenCatalogApplicationContracts.selection.parseInput(proxied)).toThrow();
    expect(() => tokenCatalogApplicationContracts.selection.parseInput({ asset, extra: true })).toThrow();
  });

  it("binds list and Review successes to the exact normalized request", async () => {
    const inspection = await createInspectionSuccess();
    const secondAsset = erc20AssetIdentitySchema.parse({ ...asset, address: `0x${"13".repeat(20)}` });
    const secondInspection = await createInspectionSuccess({ asset: secondAsset, block: { kind: "latest" } });
    const page = {
      selections: [
        selectionFor(inspection),
        selectionFor(secondInspection),
      ],
      nextCursor: secondAsset.address,
    };
    expect(tokenCatalogApplicationContracts.selections.parsePublicSuccess(
      tokenCatalogApplicationContracts.selections.parseInput({ limit: 2 }),
      page,
    )).toEqual(page);
    expect(() => tokenCatalogApplicationContracts.selections.parsePublicSuccess(
      tokenCatalogApplicationContracts.selections.parseInput({ limit: 1 }),
      page,
    )).toThrow();
    expect(() => tokenCatalogApplicationContracts.selections.parsePublicSuccess(
      tokenCatalogApplicationContracts.selections.parseInput({
      limit: 2,
      cursor: asset.address,
      }),
      page,
    )).toThrow();
    expect(() => tokenCatalogApplicationContracts.selections.parsePublicSuccess(
      tokenCatalogApplicationContracts.selections.parseInput({ limit: 3 }),
      page,
    )).toThrow();

    const review = additionReviewFor(inspection);
    const reviewResult = { review };
    expect(tokenCatalogApplicationContracts.selectionChangeReview.parsePublicSuccess(
      { kind: "add", asset },
      reviewResult,
    )).toEqual(reviewResult);
    expect(() => tokenCatalogApplicationContracts.selectionChangeReview.parsePublicSuccess(
      { kind: "add", asset: secondAsset },
      reviewResult,
    )).toThrow();
  });

  it("owns strict direct actions and correlates them with one immutable terminal result", async () => {
    const completed = await createTokenOperation({ kind: "add", initiatedBy: "mcp_app" });
    const action = { review: completed.review, initiatedBy: "mcp_app" as const };
    expect(tokenCatalogApplicationContracts.addSelection.parseInput(action)).toEqual(action);
    expect(Object.isFrozen(tokenCatalogApplicationContracts.addSelection.parseInput(action))).toBe(true);
    expect(() => tokenCatalogApplicationContracts.addSelection.parseInput({ ...action, extra: true }))
      .toThrow();
    expect(tokenCatalogApplicationContracts.addSelection.parsePublicSuccess(action, completed))
      .toEqual(completed);
    expect(() => tokenCatalogApplicationContracts.addSelection.parsePublicSuccess(action, {
      ...completed,
      operationId: Buffer.alloc(32, 7).toString("base64url"),
    })).toThrow();

    const other = await createTokenOperation({
      kind: "add",
      operationId: Buffer.alloc(32, 8).toString("base64url"),
      initiatedBy: "mcp_app",
    });
    expect(() => tokenCatalogApplicationContracts.addSelection.parsePublicSuccess(action, other))
      .toThrow();
    expect(() => tokenCatalogApplicationContracts.removeSelection.parseInput(action as never))
      .toThrow();
  });

  it("projects exact structural schemas for Review, action, and terminal operation", async () => {
    const completed = await createTokenOperation({ kind: "add", initiatedBy: "cli" });
    const reviewResult = { review: completed.review };
    const action = { review: completed.review, initiatedBy: "cli" as const };
    const schemaFor = (capabilityId: string): object => {
      const projection = tokenCatalogContractProjection.applications.find(
        (candidate) => candidate.capabilityId === capabilityId,
      );
      if (projection === undefined) throw new Error(`Missing contract projection: ${capabilityId}`);
      return projection.successSchema as object;
    };
    const ajv = new Ajv2020({
      strict: true,
      formats: { uri: true, "date-time": true },
    });
    const validateReview = ajv.compile(schemaFor("token.selection_change_review"));
    const validateAction = ajv.compile(schemaFor("token.add_selection"));
    const validateOperation = ajv.compile(schemaFor("token.operation"));

    expect(validateReview(reviewResult)).toBe(true);
    expect(validateReview({ ...reviewResult, extra: true })).toBe(false);
    expect(validateAction(completed)).toBe(true);
    expect(validateAction({ ...completed, state: "applying" })).toBe(false);
    expect(validateOperation(completed)).toBe(true);
    expect(tokenCatalogApplicationContracts.addSelection.inputSchema.parse(action)).toEqual(action);
  });

  it("narrows every operation to one completed result and exact kind", () => {
    const audit = (operation: TokenCatalogOperation): void => {
      expect(operation.state).toBe("completed");
      if (operation.kind === "remove") {
        expectTypeOf(operation.result).toEqualTypeOf<
          TokenCatalogOperationVariant<"remove">["result"]
        >();
      }
      if (operation.kind === "add") {
        expectTypeOf(operation.result).toEqualTypeOf<
          TokenCatalogOperationVariant<"add">["result"]
        >();
      }
    };
    expect(audit).toBeTypeOf("function");
  });

  it("makes historical inspection part of addition only", async () => {
    const addition = await createTokenOperation({ kind: "add" });
    const removal = await createTokenOperation({ kind: "remove" });
    expect(addition.result.selection.historicalInspection).not.toBeNull();
    if (removal.kind !== "remove") throw new TypeError("Removal fixture kind changed.");
    const absentInspection: null = removal.result.selection.historicalInspection;
    expect(absentInspection).toBeNull();

    expect(() => tokenCatalogOperationSchema.parse({
      ...addition,
      result: {
        ...addition.result,
        selection: { ...addition.result.selection, historicalInspection: null },
      },
    })).toThrow();
    expect(() => tokenCatalogOperationSchema.parse({
      ...removal,
      result: {
        ...removal.result,
        selection: {
          ...removal.result.selection,
          historicalInspection: addition.result.selection.historicalInspection,
        },
      },
    })).toThrow();

    const operationSchema = tokenCatalogApplicationContracts.operation.successSchema;
    const projected = new Ajv2020({ strict: true, formats: { uri: true, "date-time": true } })
      .compile(JSON.parse(canonicalOutputSchema(operationSchema)));
    expect(projected(addition)).toBe(true);
    expect(projected(removal)).toBe(true);
    expect(projected({
      ...removal,
      result: {
        ...removal.result,
        selection: {
          ...removal.result.selection,
          historicalInspection: addition.result.selection.historicalInspection,
        },
      },
    })).toBe(false);
  });

  it("binds completed selection results to the reviewed inspection and lifecycle", async () => {
    const add = await createTokenOperation({ kind: "add" });
    expect(tokenCatalogOperationSchema.parse(add)).toEqual(add);
    expect(() => tokenCatalogOperationSchema.parse({
      ...add,
      result: {
        ...add.result,
        selection: {
          ...add.result.selection,
          selection: {
            ...add.result.selection.selection,
            updatedAt: "2026-07-18T00:00:02.000Z",
          },
        },
      },
    })).toThrow();
  });
});
