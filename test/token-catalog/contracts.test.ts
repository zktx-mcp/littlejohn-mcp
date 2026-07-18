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
  tokenRegistrationChangesSchema,
  tokenRegistrationRevisionSchema,
  tokenUserLabelSchema,
  type TokenCatalogOperation,
  type TokenCatalogOperationVariant,
  type TokenInspectionSuccess,
  type TokenRegistration,
  type TokenRegistrationSettings,
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
  settings: TokenRegistrationSettings = { userLabel: null, visibility: "visible" },
  revision = revisionA,
): TokenRegistration => ({
  account: { chainId: inspection.data.asset.chainId, address: walletAddress },
  asset: inspection.data.asset,
  revision,
  inspectionDigest: tokenInspectionDigest(inspection),
  ...settings,
  createdAt,
  updatedAt: createdAt,
});

const awaitingOperation = (input: Readonly<{
  inspection: TokenInspectionSuccess;
  kind: TokenCatalogOperation["kind"];
  previousRegistration: TokenRegistration | null;
  proposedSettings: TokenRegistrationSettings | null;
}>): TokenCatalogOperation => tokenCatalogOperationSchema.parse({
  operationId,
  kind: input.kind,
  state: "awaiting_confirmation",
  interactionInterface: "web",
  createdAt,
  expiresAt,
  account: { chainId: input.inspection.data.asset.chainId, address: walletAddress },
  asset: input.inspection.data.asset,
  review: {
    previousRegistration: input.previousRegistration,
    proposedSettings: input.proposedSettings,
    inspection: input.inspection,
    reviewDigest: `0x${"ab".repeat(32)}`,
  },
  result: null,
  failure: null,
});

describe("token catalog contracts", () => {
  it("owns exactly the eight accepted capability identifiers at contract version 3", () => {
    expect(coreContractVersion).toBe("3");
    expect(getCapabilityDefinitionSnapshot(tokenInspectCapability).contractVersion).toBe("3");
    expect(tokenCatalogCapabilityIds).toEqual([
      "token.cancel_operation",
      "token.inspect",
      "token.operation",
      "token.registration",
      "token.registrations",
      "token.start_registration",
      "token.start_registration_update",
      "token.start_unregistration",
    ]);
    expect(tokenCatalogContractProjection.contractVersion).toBe("3");
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

  it("normalizes only declared defaults and rejects empty update changes", () => {
    expect(tokenCatalogApplicationContracts.registrations.parseInput({})).toEqual({
      limit: 25,
      cursor: null,
    });
    expect(tokenCatalogApplicationContracts.startRegistration.parseInput({ asset })).toEqual({
      asset,
      settings: { userLabel: null, visibility: "visible" },
    });
    expect(tokenRegistrationChangesSchema.safeParse({}).success).toBe(false);
    expect(tokenRegistrationChangesSchema.safeParse({ userLabel: null }).success).toBe(true);
  });

  it("uses exact opaque identifier sizes and the bounded safe text contract", () => {
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
    expect(tokenUserLabelSchema.safeParse("a".repeat(128)).success).toBe(true);
    expect(tokenUserLabelSchema.safeParse("a".repeat(129)).success).toBe(false);
    expect(tokenUserLabelSchema.safeParse("line\nbreak").success).toBe(false);
    expect(tokenUserLabelSchema.safeParse("\u202Ehidden").success).toBe(false);
    expect(tokenUserLabelSchema.safeParse("").success).toBe(false);
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
    expect(tokenCatalogApplicationContracts.registrations.parseSuccess(
      tokenCatalogApplicationContracts.registrations.parseInput({ limit: 2 }),
      page,
    )).toEqual(page);
    expect(() => tokenCatalogApplicationContracts.registrations.parseSuccess(
      tokenCatalogApplicationContracts.registrations.parseInput({ limit: 1 }),
      page,
    )).toThrow();
    expect(() => tokenCatalogApplicationContracts.registrations.parseSuccess(
      tokenCatalogApplicationContracts.registrations.parseInput({
      limit: 2,
      cursor: asset.address,
      }),
      page,
    )).toThrow();
    expect(() => tokenCatalogApplicationContracts.registrations.parseSuccess(
      tokenCatalogApplicationContracts.registrations.parseInput({ limit: 3 }),
      page,
    )).toThrow();

    const registerSettings = { userLabel: "Example", visibility: "visible" as const };
    const register = awaitingOperation({
      inspection,
      kind: "register",
      previousRegistration: null,
      proposedSettings: registerSettings,
    });
    const registerSuccess = { operation: register };
    expect(tokenCatalogApplicationContracts.startRegistration.parseSuccess({
      asset,
      settings: registerSettings,
    }, registerSuccess)).toEqual(registerSuccess);
    expect(() => tokenCatalogApplicationContracts.startRegistration.parseSuccess({
      asset,
      settings: { userLabel: null, visibility: "visible" },
    }, registerSuccess)).toThrow();
    expect(() => tokenCatalogApplicationContracts.startRegistration.parseSuccess({
      asset: secondAsset,
      settings: registerSettings,
    }, registerSuccess)).toThrow();

    const previous = registrationFor(inspection, registerSettings);
    const proposedSettings = { userLabel: null, visibility: "hidden" as const };
    const update = awaitingOperation({
      inspection,
      kind: "update_registration",
      previousRegistration: previous,
      proposedSettings,
    });
    const updateSuccess = { operation: update };
    expect(tokenCatalogApplicationContracts.startRegistrationUpdate.parseSuccess({
      asset,
      expectedRevision: revisionA,
      changes: proposedSettings,
    }, updateSuccess)).toEqual(updateSuccess);
    expect(() => tokenCatalogApplicationContracts.startRegistrationUpdate.parseSuccess({
      asset,
      expectedRevision: revisionB,
      changes: proposedSettings,
    }, updateSuccess)).toThrow();

    const unregister = awaitingOperation({
      inspection,
      kind: "unregister",
      previousRegistration: previous,
      proposedSettings: null,
    });
    const unregisterSuccess = { operation: unregister };
    expect(tokenCatalogApplicationContracts.startUnregistration.parseSuccess({
      asset,
      expectedRevision: revisionA,
    }, unregisterSuccess)).toEqual(unregisterSuccess);
    expect(() => tokenCatalogApplicationContracts.startUnregistration.parseSuccess({
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
      proposedSettings: { userLabel: null, visibility: "visible" },
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
    expect(tokenCatalogOperationConfirmationContract.parseSuccess(input, completed)).toEqual(completed);
    expect(tokenCatalogOperationConfirmationContract.parseSuccess(input, failed)).toEqual(failed);
    expect(() => tokenCatalogOperationConfirmationContract.parseSuccess({
      ...input,
      operationId: "B".repeat(43),
    }, completed)).toThrow();
    expect(() => tokenCatalogOperationConfirmationContract.parseSuccess({
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
      proposedSettings: { userLabel: null, visibility: "visible" },
    });
    const applying = tokenCatalogOperationSchema.parse({ ...awaiting, state: "applying" });
    const cancelled = tokenCatalogOperationSchema.parse({ ...awaiting, state: "cancelled" });
    const input = tokenCatalogApplicationContracts.startRegistration.parseInput({ asset });

    expect(tokenCatalogApplicationContracts.startRegistration.parseSuccess(input, { operation: awaiting }))
      .toEqual({ operation: awaiting });
    expect(() => tokenCatalogApplicationContracts.startRegistration.parseSuccess(input, {
      operation: applying,
    })).toThrow();
    expect(() => tokenCatalogApplicationContracts.startRegistration.parseSuccess(input, {
      operation: awaiting,
      managementUrl: "http://127.0.0.1:46630/tokens",
    })).toThrow();
    expect(tokenCatalogApplicationContracts.cancelOperation.parseSuccess(
      { operationId: cancelled.operationId },
      { operation: cancelled },
    )).toEqual({ operation: cancelled });
    expect(() => tokenCatalogApplicationContracts.cancelOperation.parseSuccess(
      { operationId: awaiting.operationId },
      { operation: awaiting },
    )).toThrow();
    expect(() => tokenCatalogApplicationContracts.cancelOperation.parseSuccess(
      { operationId: applying.operationId },
      { operation: applying },
    )).toThrow();
    expect(() => tokenCatalogApplicationContracts.cancelOperation.parseSuccess(
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
      proposedSettings: { userLabel: null, visibility: "visible" },
    });
    const applying = tokenCatalogOperationSchema.parse({ ...awaiting, state: "applying" });
    const cancelled = tokenCatalogOperationSchema.parse({ ...awaiting, state: "cancelled" });
    const update = awaitingOperation({
      inspection,
      kind: "update_registration",
      previousRegistration: registrationFor(inspection),
      proposedSettings: { userLabel: null, visibility: "hidden" },
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
    expect(validateStart({ operation: update })).toBe(false);
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
    const settings = { userLabel: "Example", visibility: "visible" as const };
    const register = awaitingOperation({
      inspection,
      kind: "register",
      previousRegistration: null,
      proposedSettings: settings,
    });
    const created = registrationFor(inspection, settings);
    expect(tokenCatalogOperationSchema.parse({
      ...register,
      state: "completed",
      result: { registration: created, inspection },
    })).toMatchObject({ state: "completed", result: { registration: { revision: revisionA } } });
    expect(() => tokenCatalogOperationSchema.parse({
      ...register,
      state: "completed",
      result: {
        registration: { ...created, updatedAt: "2026-07-18T00:00:04.000Z" },
        inspection,
      },
    })).toThrow();

    const update = awaitingOperation({
      inspection,
      kind: "update_registration",
      previousRegistration: created,
      proposedSettings: { userLabel: null, visibility: "hidden" },
    });
    const updated = {
      ...created,
      revision: revisionB,
      userLabel: null,
      visibility: "hidden" as const,
      updatedAt: "2026-07-18T00:00:04.000Z",
    };
    expect(tokenCatalogOperationSchema.parse({
      ...update,
      state: "completed",
      result: { registration: updated, inspection },
    })).toMatchObject({ state: "completed", result: { registration: { revision: revisionB } } });
    expect(() => tokenCatalogOperationSchema.parse({
      ...update,
      state: "completed",
      result: { registration: { ...updated, revision: revisionA }, inspection },
    })).toThrow();
    expect(() => tokenCatalogOperationSchema.parse({
      ...update,
      state: "completed",
      result: {
        registration: { ...updated, createdAt: "2026-07-18T00:00:02.000Z" },
        inspection,
      },
    })).toThrow();
  });
});
