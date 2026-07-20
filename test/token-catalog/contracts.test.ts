import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  coreContractVersion,
  erc20AssetIdentitySchema,
  getCapabilityDefinitionSnapshot,
  parseUtcTimestamp,
  type ApplicationFailure,
} from "../../src/core/index.js";
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
  tokenInspectionInputSchema,
  tokenRegistrationRevisionSchema,
  type TokenCatalogOperation,
  type TokenCatalogOperationVariant,
  type TokenInspectionSuccess,
  type TokenRegistration,
} from "../../src/token-catalog/index.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import { createInspectionSuccess, walletAddress } from "./harness.js";

const asset = erc20AssetIdentitySchema.parse({
  kind: "erc20",
  chainId: "eip155:4663",
  address: `0x${"12".repeat(20)}`,
});

const operationId = "A".repeat(43);
const revisionA = Buffer.alloc(16, 1).toString("base64url");
const revisionB = Buffer.alloc(16, 2).toString("base64url");
const createdAt = parseUtcTimestamp("2026-07-18T00:00:03.000Z");
const expiresAt = parseUtcTimestamp("2026-07-18T00:05:03.000Z");

const registrationFor = (
  inspection: TokenInspectionSuccess,
  revision = revisionA,
): TokenRegistration => ({
  account: { chainId: inspection.data.asset.chainId, address: walletAddress },
  asset: inspection.data.asset,
  revision,
  inspectionDigest: tokenInspectionDigest(inspection),
  createdAt,
});

const awaitingOperation = (input: Readonly<{
  inspection: TokenInspectionSuccess;
  kind: TokenCatalogOperation["kind"];
  previousRegistration: TokenRegistration | null;
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
    previousRegistration: input.previousRegistration,
    inspection: input.inspection,
    reviewDigest: `0x${"ab".repeat(32)}`,
  },
  result: null,
  failure: null,
});

describe("token catalog contracts", () => {
  it("owns exactly the seven membership capability identifiers at contract version 4", () => {
    expect(coreContractVersion).toBe("4");
    expect(getCapabilityDefinitionSnapshot(tokenInspectCapability).contractVersion).toBe("4");
    expect(tokenCatalogCapabilityIds).toEqual([
      "token.cancel_operation",
      "token.inspect",
      "token.operation",
      "token.registration",
      "token.registrations",
      "token.start_registration",
      "token.start_unregistration",
    ]);
    expect(tokenCatalogContractProjection.contractVersion).toBe("4");
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
    expect(tokenCatalogApplicationContracts.startRegistration.failureCodes)
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
    expect(() => tokenCatalogApplicationContracts.registration.parseInput({
      asset,
      walletAddress: `0x${"34".repeat(20)}`,
    })).toThrow();
  });

  it("normalizes only the declared list defaults and keeps registration input exact", () => {
    expect(tokenCatalogApplicationContracts.registrations.parseInput({})).toEqual({
      limit: 25,
      cursor: null,
    });
    expect(tokenCatalogApplicationContracts.startRegistration.parseInput({ asset })).toEqual({ asset });
    expect(() => tokenCatalogApplicationContracts.startRegistration.parseInput({
      asset,
      settings: {},
    })).toThrow();
  });

  it("uses exact opaque identifier sizes", () => {
    expect(tokenCatalogContractLimits).toEqual({
      displayTextCodePoints: 128,
      displayTextUtf8Bytes: 512,
      registrationRevisionBytes: 16,
      operationIdBytes: 32,
      listDefaultLimit: 25,
      listMaximumLimit: 25,
    });
    expect(tokenRegistrationRevisionSchema.safeParse("A".repeat(22)).success).toBe(true);
    expect(tokenRegistrationRevisionSchema.safeParse("A".repeat(21)).success).toBe(false);
    expect(tokenCatalogOperationIdSchema.safeParse("A".repeat(43)).success).toBe(true);
    expect(tokenCatalogOperationIdSchema.safeParse("A".repeat(44)).success).toBe(false);
  });

  it("rejects accessor, proxy, and additional-field inputs before authority use", () => {
    const accessor = Object.defineProperty({}, "asset", {
      enumerable: true,
      get: () => asset,
    });
    expect(() => tokenCatalogApplicationContracts.registration.parseInput(accessor)).toThrow();

    const proxied = new Proxy({ asset }, {
      ownKeys: () => { throw new Error("trap"); },
    });
    expect(() => tokenCatalogApplicationContracts.registration.parseInput(proxied)).toThrow();
    expect(() => tokenCatalogApplicationContracts.registration.parseInput({ asset, extra: true })).toThrow();
  });

  it("binds list and operation-start successes to the exact normalized request", async () => {
    const inspection = await createInspectionSuccess();
    const secondAsset = erc20AssetIdentitySchema.parse({ ...asset, address: `0x${"13".repeat(20)}` });
    const secondInspection = await createInspectionSuccess({ asset: secondAsset, block: { kind: "latest" } });
    const page = {
      registrations: [
        registrationFor(inspection),
        registrationFor(secondInspection),
      ],
      nextCursor: secondAsset.address,
    };
    expect(tokenCatalogApplicationContracts.registrations.parsePublicSuccess(
      tokenCatalogApplicationContracts.registrations.parseInput({ limit: 2 }),
      page,
    )).toEqual(page);
    expect(() => tokenCatalogApplicationContracts.registrations.parsePublicSuccess(
      tokenCatalogApplicationContracts.registrations.parseInput({ limit: 1 }),
      page,
    )).toThrow();
    expect(() => tokenCatalogApplicationContracts.registrations.parsePublicSuccess(
      tokenCatalogApplicationContracts.registrations.parseInput({
      limit: 2,
      cursor: asset.address,
      }),
      page,
    )).toThrow();
    expect(() => tokenCatalogApplicationContracts.registrations.parsePublicSuccess(
      tokenCatalogApplicationContracts.registrations.parseInput({ limit: 3 }),
      page,
    )).toThrow();

    const register = awaitingOperation({
      inspection,
      kind: "register",
      previousRegistration: null,
    });
    const registerSuccess = { operation: register };
    expect(tokenCatalogApplicationContracts.startRegistration.parsePublicSuccess({ asset }, registerSuccess))
      .toEqual(registerSuccess);
    expect(() => tokenCatalogApplicationContracts.startRegistration.parsePublicSuccess({
      asset: secondAsset,
    }, registerSuccess)).toThrow();

    const previous = registrationFor(inspection);
    const unregister = awaitingOperation({
      inspection,
      kind: "unregister",
      previousRegistration: previous,
    });
    const unregisterSuccess = { operation: unregister };
    expect(tokenCatalogApplicationContracts.startUnregistration.parsePublicSuccess({
      asset,
      expectedRevision: revisionA,
    }, unregisterSuccess)).toEqual(unregisterSuccess);
    expect(() => tokenCatalogApplicationContracts.startUnregistration.parsePublicSuccess({
      asset,
      expectedRevision: revisionB,
    }, unregisterSuccess)).toThrow();
  });

  it("owns one strict confirmation input, success, and failure contract", async () => {
    const inspection = await createInspectionSuccess();
    const awaiting = awaitingOperation({
      inspection,
      kind: "register",
      previousRegistration: null,
    });
    const input = {
      operationId: awaiting.operationId,
      reviewDigest: awaiting.review.reviewDigest,
    };
    const completed = tokenCatalogOperationSchema.parse({
      ...awaiting,
      state: "completed",
      result: {
        registration: registrationFor(inspection),
        inspection,
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
      kind: "register",
      previousRegistration: null,
    });
    const applying = tokenCatalogOperationSchema.parse({ ...awaiting, state: "applying" });
    const cancelled = tokenCatalogOperationSchema.parse({ ...awaiting, state: "cancelled" });
    const input = tokenCatalogApplicationContracts.startRegistration.parseInput({ asset });

    expect(tokenCatalogApplicationContracts.startRegistration.parsePublicSuccess(input, { operation: awaiting }))
      .toEqual({ operation: awaiting });
    expect(() => tokenCatalogApplicationContracts.startRegistration.parsePublicSuccess(input, {
      operation: applying,
    })).toThrow();
    expect(() => tokenCatalogApplicationContracts.startRegistration.parsePublicSuccess(input, {
      operation: awaiting,
      managementUrl: "http://127.0.0.1:46630/tokens",
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
      kind: "register",
      previousRegistration: null,
    });
    const applying = tokenCatalogOperationSchema.parse({ ...awaiting, state: "applying" });
    const cancelled = tokenCatalogOperationSchema.parse({ ...awaiting, state: "cancelled" });
    const wrongKind = awaitingOperation({
      inspection,
      kind: "unregister",
      previousRegistration: registrationFor(inspection),
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
    const validateStart = ajv.compile(schemaFor("token.start_registration"));
    const validateCancel = ajv.compile(schemaFor("token.cancel_operation"));

    expect(validateStart({ operation: awaiting })).toBe(true);
    expect(validateStart({ operation: applying })).toBe(false);
    expect(validateStart({ operation: wrongKind })).toBe(false);
    expect(validateStart({ operation: awaiting, managementUrl: "http://127.0.0.1:46630/tokens" })).toBe(false);
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
      if (operation.state === "completed" && operation.kind === "unregister") {
        expectTypeOf(operation.result).toEqualTypeOf<
          TokenCatalogOperationVariant<"unregister", "completed">["result"]
        >();
        expectTypeOf(operation.failure).toEqualTypeOf<null>();
      }
      if (operation.state === "completed" && operation.kind === "register") {
        expectTypeOf(operation.result).toEqualTypeOf<
          TokenCatalogOperationVariant<"register", "completed">["result"]
        >();
      }
    };
    expect(audit).toBeTypeOf("function");
  });

  it("binds completed registration results to the reviewed inspection and lifecycle", async () => {
    const inspection = await createInspectionSuccess();
    const register = awaitingOperation({
      inspection,
      kind: "register",
      previousRegistration: null,
    });
    const created = registrationFor(inspection);
    expect(tokenCatalogOperationSchema.parse({
      ...register,
      state: "completed",
      result: { registration: created, inspection },
    })).toMatchObject({ state: "completed", result: { registration: { revision: revisionA } } });
    expect(() => tokenCatalogOperationSchema.parse({
      ...register,
      state: "completed",
      result: {
        registration: { ...created, createdAt: "2026-07-18T00:00:02.000Z" },
        inspection,
      },
    })).toThrow();
  });
});
