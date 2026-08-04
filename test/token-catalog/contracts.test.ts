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
  parseUtcTimestamp,
  type ApplicationFailure,
  type CanonicalJson,
} from "../../src/core/index.js";
import { internalResponseLimitBytes } from "../../src/runtime/http-boundary.js";
import {
  tokenCatalogApplicationContracts,
  tokenCatalogCapabilityIds,
  tokenCatalogContractLimits,
  tokenCatalogContractProjection,
  tokenCatalogContractProjectionDigest,
  tokenCatalogErrorDefinitions,
  tokenCatalogInterfaceErrorMappingDefinitions,
  tokenCatalogOperationConfirmationContract,
  tokenCatalogOperationIdSchema,
  tokenCatalogOperationSchema,
  tokenInspectCapability,
  tokenInspectionDigest,
  tokenInspectionDataSchema,
  tokenInspectionInputSchema,
  tokenInspectionSuccessSchema,
  tokenSelectionRevisionSchema,
  tokenSelectionSchema,
  type TokenCatalogOperation,
  type TokenCatalogOperationVariant,
  type TokenInspectionSuccess,
  type TokenSelection,
} from "../../src/token-catalog/index.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import { createInspectionSuccess, walletAddress } from "./harness.js";
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
const revisionB = Buffer.alloc(16, 2).toString("base64url");
const snapshotRevision = Buffer.alloc(16, 3).toString("base64url");
const createdAt = parseUtcTimestamp("2026-07-18T00:00:03.000Z");
const expiresAt = parseUtcTimestamp("2026-07-18T00:05:03.000Z");

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

const awaitingOperation = (input: Readonly<{
  inspection: TokenInspectionSuccess;
  kind: TokenCatalogOperation["kind"];
  previousSelection: TokenSelection | null;
}>): TokenCatalogOperation => tokenCatalogOperationSchema.parse({
  operationId,
  kind: input.kind,
  state: "awaiting_confirmation",
  interactionInterface: "web",
  createdAt,
  expiresAt,
  account: { chainId: input.inspection.data.asset.chainId, address: walletAddress },
  connectionRevision: "1",
  asset: input.inspection.data.asset,
  review: {
    previousSelection: input.previousSelection,
    selectionSetRevision: null,
    inspection: input.kind === "add" ? input.inspection : null,
    inspectionDigest: input.kind === "add" ? tokenInspectionDigest(input.inspection) : null,
    officialSnapshotRevision: input.kind === "add" ? snapshotRevision : null,
    officialEvidence: null,
    reviewDigest: `0x${"ab".repeat(32)}`,
  },
  result: null,
  failure: null,
});

describe("token catalog contracts", () => {
  it("preserves the independent token inspection schema projections", () => {
    for (const [schema, expectedBytes, expectedDigest] of [
      [
        tokenInspectionDataSchema,
        13_015,
        "e12e2f6330a05bc98e3feeb9acd2e6a71948bfb3cb561a45a6da34513baf762f",
      ],
      [
        tokenInspectionSuccessSchema,
        19_744,
        "cc0fe87cc842dc220728132dc9a633dc8e5083862b7db6708b2ee864edc355e1",
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
      "token.cancel_operation",
      "token.inspect",
      "token.operation",
      "token.selection",
      "token.selections",
      "token.start_addition",
      "token.start_removal",
    ]);
    expect(applicationVersions).toEqual({
      "token.cancel_operation": "1",
      "token.operation": "1",
      "token.selection": "1",
      "token.selections": "1",
      "token.start_addition": "1",
      "token.start_removal": "1",
    });
    expect(tokenCatalogOperationConfirmationContract.contractVersion).toBe("1");
    expect(tokenCatalogContractProjection.contractVersion).toBe("1");
    expect(tokenCatalogContractProjection.inspection).toEqual(inspectionContract);
    expect(Object.fromEntries(tokenCatalogContractProjection.applications.map((contract) => [
      contract.capabilityId,
      contract.contractVersion,
    ]))).toEqual(applicationVersions);
    expect(tokenCatalogContractProjection.operationConfirmation.contractVersion)
      .toBe(tokenCatalogOperationConfirmationContract.contractVersion);
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
    expect(tokenCatalogApplicationContracts.startAddition.failureCodes)
      .toContain("token_total_supply_reverted");
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
    const operation = awaitingOperation({
      inspection: original,
      kind: "add",
      previousSelection: null,
    });
    expect(() => tokenCatalogOperationSchema.parse({
      ...operation,
      review: {
        ...operation.review,
        inspection: changedInspection,
        inspectionDigest: tokenInspectionDigest(changedInspection),
      },
    }), "operation review").toThrow();

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

    const add = awaitingOperation({
      inspection,
      kind: "add",
      previousSelection: null,
    });
    const officialEvidence = {
      assetUid: `0x${"56".repeat(32)}`,
      snapshotRevision,
      verificationBlock: inspection.data.analysis.block,
    };
    expect(() => tokenCatalogOperationSchema.parse({
      ...add,
      review: { ...add.review, officialEvidence },
    })).not.toThrow();

    for (const mutation of anchorMutations) {
      expect(() => tokenCatalogOperationSchema.parse({
        ...add,
        review: {
          ...add.review,
          officialEvidence: {
            ...officialEvidence,
            verificationBlock: {
              ...officialEvidence.verificationBlock,
              [mutation.field]: mutation.value,
            },
          },
        },
      })).toThrow();
    }
  });

  it("normalizes only the declared list defaults and keeps selection input exact", () => {
    expect(tokenCatalogApplicationContracts.selections.parseInput({})).toEqual({
      limit: 25,
      cursor: null,
    });
    expect(tokenCatalogApplicationContracts.startAddition.parseInput({ asset })).toEqual({ asset });
    expect(() => tokenCatalogApplicationContracts.startAddition.parseInput({
      asset,
      settings: {},
    })).toThrow();
  });

  it("uses exact opaque identifier sizes", () => {
    expect(tokenCatalogContractLimits).toEqual({
      displayTextCodePoints: 128,
      displayTextUtf8Bytes: 512,
      selectionRevisionBytes: 16,
      operationIdBytes: 32,
      listDefaultLimit: 25,
      listMaximumLimit: 25,
    });
    expect(tokenSelectionRevisionSchema.safeParse("A".repeat(22)).success).toBe(true);
    expect(tokenSelectionRevisionSchema.safeParse("A".repeat(21)).success).toBe(false);
    expect(tokenCatalogOperationIdSchema.safeParse("A".repeat(43)).success).toBe(true);
    expect(tokenCatalogOperationIdSchema.safeParse("A".repeat(44)).success).toBe(false);
  });

  it("keeps the actual maximum selection page within the compatible-process response limit", () => {
    const chainId = `eip155:${"9".repeat(32)}`;
    const maximumAddress = BigInt(`0x${"f".repeat(40)}`);
    const timestamp = "9999-12-31T23:59:59.999Z";
    const selections = Array.from({ length: tokenCatalogContractLimits.listMaximumLimit }, (_, index) =>
      tokenSelectionSchema.parse({
        account: { chainId, address: `0x${"f".repeat(40)}` },
        asset: {
          kind: "erc20",
          chainId,
          address: `0x${(maximumAddress - BigInt(
            tokenCatalogContractLimits.listMaximumLimit - index - 1,
          )).toString(16).padStart(40, "0")}`,
        },
        included: index % 2 === 0,
        revision: Buffer.alloc(tokenCatalogContractLimits.selectionRevisionBytes, index + 1)
          .toString("base64url"),
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    const page = tokenCatalogApplicationContracts.selections.parsePublicSuccess(
      { limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null },
      { selections, nextCursor: null },
    );
    expect(Buffer.byteLength(`${canonicalJsonStringify(captureCanonicalJson(page))}\n`, "utf8"))
      .toBeLessThanOrEqual(internalResponseLimitBytes);
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

  it("binds list and operation-start successes to the exact normalized request", async () => {
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

    const add = awaitingOperation({
      inspection,
      kind: "add",
      previousSelection: null,
    });
    const registerSuccess = { operation: add };
    expect(tokenCatalogApplicationContracts.startAddition.parsePublicSuccess({ asset }, registerSuccess))
      .toEqual(registerSuccess);
    expect(() => tokenCatalogApplicationContracts.startAddition.parseInput({
      asset,
      expectedRevision: revisionA,
    })).toThrow();
    expect(() => tokenCatalogApplicationContracts.startAddition.parsePublicSuccess({
      asset: secondAsset,
    }, registerSuccess)).toThrow();

    const previous = selectionFor(inspection);
    const remove = awaitingOperation({
      inspection,
      kind: "remove",
      previousSelection: previous,
    });
    const unregisterSuccess = { operation: remove };
    expect(tokenCatalogApplicationContracts.startRemoval.parsePublicSuccess({
      asset,
      expectedRevision: revisionA,
    }, unregisterSuccess)).toEqual(unregisterSuccess);
    expect(() => tokenCatalogApplicationContracts.startRemoval.parsePublicSuccess({
      asset,
      expectedRevision: revisionB,
    }, unregisterSuccess)).toThrow();
  });

  it("owns one strict confirmation input, success, and failure contract", async () => {
    const inspection = await createInspectionSuccess();
    const awaiting = awaitingOperation({
      inspection,
      kind: "add",
      previousSelection: null,
    });
    const input = {
      operationId: awaiting.operationId,
      reviewDigest: awaiting.review.reviewDigest,
    };
    const completed = tokenCatalogOperationSchema.parse({
      ...awaiting,
      state: "completed",
      result: {
        selection: selectionFor(inspection),
        historicalInspection: inspection,
      },
    });
    const failed = tokenCatalogOperationSchema.parse({
      ...awaiting,
      state: "failed",
      failure: new TokenCatalogOperationError("state_conflict").failure,
    });

    expect(tokenCatalogOperationConfirmationContract.parseInput(input)).toEqual(input);
    expect(Object.isFrozen(tokenCatalogOperationConfirmationContract.parseInput(input))).toBe(true);
    expect(() => tokenCatalogOperationConfirmationContract.parseInput({ ...input, extra: true })).toThrow();
    expect(() => tokenCatalogOperationConfirmationContract.parseInput({
      ...input,
      reviewDigest: input.reviewDigest.toUpperCase(),
    })).toThrow();
    expect(tokenCatalogOperationConfirmationContract.parsePublicSuccess(input, completed)).toEqual(completed);
    expect(tokenCatalogOperationConfirmationContract.parsePublicSuccess(input, failed)).toEqual(failed);
    expect(() => tokenCatalogOperationConfirmationContract.parsePublicSuccess({
      ...input,
      operationId: "B".repeat(43),
    }, completed)).toThrow();
    expect(() => tokenCatalogOperationConfirmationContract.parsePublicSuccess({
      ...input,
      reviewDigest: `0x${"cd".repeat(32)}`,
    }, completed)).toThrow();

    const declaredFailure = new TokenCatalogOperationError("state_conflict").failure;
    expect(tokenCatalogOperationConfirmationContract.parseFailure(declaredFailure)).toEqual(declaredFailure);
    expect(() => tokenCatalogOperationConfirmationContract.parseFailure(
      new TokenCatalogOperationError("wallet_not_connected").failure,
    )).toThrow();
    expect(tokenCatalogContractProjection.operationConfirmation.failureCodes).toEqual([
      "internal_error",
      "invalid_input",
      "runtime_state_unavailable",
      "state_conflict",
      "token_operation_expired",
      "token_operation_not_found",
    ]);

    const ajv = new Ajv2020({ strict: true, formats: { uri: true, "date-time": true } });
    const validateInput = ajv.compile(tokenCatalogContractProjection.operationConfirmation.inputSchema as object);
    const validateSuccess = ajv.compile(tokenCatalogContractProjection.operationConfirmation.successSchema as object);
    expect(validateInput(input)).toBe(true);
    expect(validateInput({ ...input, extra: true })).toBe(false);
    expect(validateSuccess(completed)).toBe(true);
    expect(validateSuccess(awaiting)).toBe(false);
  });

  it("keeps start results pending and cancellation results terminal", async () => {
    const inspection = await createInspectionSuccess();
    const awaiting = awaitingOperation({
      inspection,
      kind: "add",
      previousSelection: null,
    });
    const applying = tokenCatalogOperationSchema.parse({ ...awaiting, state: "applying" });
    const cancelled = tokenCatalogOperationSchema.parse({ ...awaiting, state: "cancelled" });
    const input = tokenCatalogApplicationContracts.startAddition.parseInput({ asset });

    expect(tokenCatalogApplicationContracts.startAddition.parsePublicSuccess(input, { operation: awaiting }))
      .toEqual({ operation: awaiting });
    expect(() => tokenCatalogApplicationContracts.startAddition.parsePublicSuccess(input, {
      operation: applying,
    })).toThrow();
    expect(() => tokenCatalogApplicationContracts.startAddition.parsePublicSuccess(input, {
      operation: awaiting,
      managementUrl: "http://127.0.0.1:46630/",
    })).toThrow();
    expect(tokenCatalogApplicationContracts.cancelOperation.parsePublicSuccess(
      { operationId: cancelled.operationId },
      { operation: cancelled },
    )).toEqual({ operation: cancelled });
    expect(() => tokenCatalogApplicationContracts.cancelOperation.parsePublicSuccess(
      { operationId: awaiting.operationId },
      { operation: awaiting },
    )).toThrow();
    expect(() => tokenCatalogApplicationContracts.cancelOperation.parsePublicSuccess(
      { operationId: applying.operationId },
      { operation: applying },
    )).toThrow();
    expect(() => tokenCatalogApplicationContracts.cancelOperation.parsePublicSuccess(
      { operationId: "B".repeat(43) },
      { operation: cancelled },
    )).toThrow();
  });

  it("projects exact structural schemas for start and cancellation results", async () => {
    const inspection = await createInspectionSuccess();
    const awaiting = awaitingOperation({
      inspection,
      kind: "add",
      previousSelection: null,
    });
    const applying = tokenCatalogOperationSchema.parse({ ...awaiting, state: "applying" });
    const cancelled = tokenCatalogOperationSchema.parse({ ...awaiting, state: "cancelled" });
    const wrongKind = awaitingOperation({
      inspection,
      kind: "remove",
      previousSelection: selectionFor(inspection),
    });
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
    const validateStart = ajv.compile(schemaFor("token.start_addition"));
    const validateCancel = ajv.compile(schemaFor("token.cancel_operation"));

    expect(validateStart({ operation: awaiting })).toBe(true);
    expect(validateStart({ operation: applying })).toBe(false);
    expect(validateStart({ operation: wrongKind })).toBe(false);
    expect(validateStart({ operation: awaiting, managementUrl: "http://127.0.0.1:46630/" })).toBe(false);
    expect(validateCancel({ operation: cancelled })).toBe(true);
    expect(validateCancel({ operation: awaiting })).toBe(false);
    expect(validateCancel({ operation: applying })).toBe(false);
  });

  it("preserves operation result and failure correlation during type narrowing", () => {
    const audit = (operation: TokenCatalogOperation): void => {
      if (operation.state === "failed") {
        expectTypeOf(operation.failure).toEqualTypeOf<ApplicationFailure>();
        expectTypeOf(operation.result).toEqualTypeOf<null>();
      }
      if (operation.state === "awaiting_confirmation" || operation.state === "applying") {
        expectTypeOf(operation.failure).toEqualTypeOf<null>();
        expectTypeOf(operation.result).toEqualTypeOf<null>();
      }
      if (operation.state === "completed" && operation.kind === "remove") {
        expectTypeOf(operation.result).toEqualTypeOf<
          TokenCatalogOperationVariant<"remove", "completed">["result"]
        >();
        expectTypeOf(operation.failure).toEqualTypeOf<null>();
      }
      if (operation.state === "completed" && operation.kind === "add") {
        expectTypeOf(operation.result).toEqualTypeOf<
          TokenCatalogOperationVariant<"add", "completed">["result"]
        >();
      }
    };
    expect(audit).toBeTypeOf("function");
  });

  it("binds completed selection results to the reviewed inspection and lifecycle", async () => {
    const inspection = await createInspectionSuccess();
    const add = awaitingOperation({
      inspection,
      kind: "add",
      previousSelection: null,
    });
    const created = selectionFor(inspection);
    expect(tokenCatalogOperationSchema.parse({
      ...add,
      state: "completed",
      result: { selection: created, historicalInspection: inspection },
    })).toMatchObject({ state: "completed", result: { selection: { revision: revisionA } } });
    expect(() => tokenCatalogOperationSchema.parse({
      ...add,
      state: "completed",
      result: {
        selection: { ...created, createdAt: "2026-07-18T00:00:02.000Z" },
        historicalInspection: inspection,
      },
    })).toThrow();
  });
});
