import { createHash } from "node:crypto";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  applicationFailureSchemaFor,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  walletManagementContracts,
  walletManagementInternalContextSchema,
  walletOperationConfirmationContract,
  type AnyWalletManagementContract,
} from "../../src/wallet/management-contracts.js";
import { walletErrorRegistry } from "../../src/wallet/error-registry.js";
import {
  parseWalletManagementOperation,
  walletOperationIdByteLength,
  type WalletManagementOperation,
} from "../../src/wallet/operation-contract.js";
import type { WalletOperationKind } from "../../src/wallet/operation-state.js";

const operationId = Buffer.alloc(walletOperationIdByteLength, 61).toString("base64url");
const otherOperationId = Buffer.alloc(walletOperationIdByteLength, 62).toString("base64url");
const connected = Object.freeze({
  status: "connected" as const,
  address: "0x1111111111111111111111111111111111111111",
  chainId: "eip155:4663" as const,
  approvedMethods: Object.freeze(["eth_sendTransaction"]),
  approvedEvents: Object.freeze(["accountsChanged", "chainChanged"]),
  expiresAt: "2026-07-17T03:00:00.000Z",
});

const operation = (
  kind: WalletOperationKind,
  id = operationId,
): WalletManagementOperation => parseWalletManagementOperation({
  operationId: id,
  kind,
  state: kind === "disconnect" ? "awaiting_confirmation" : "awaiting_wallet_approval",
  connectionRevision: "7",
  actionExpiresAt: "2026-07-17T02:00:00.000Z",
  interactionInterface: "web",
  result: null,
  failure: null,
  peerRefusalCode: null,
});

const outputSchema = (schema: z.ZodType): Record<string, unknown> =>
  JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "throw",
  }))) as Record<string, unknown>;

const managementContractProjection = (contract: AnyWalletManagementContract) => ({
  capabilityId: contract.capabilityId,
  contractVersion: contract.contractVersion,
  inputSchema: outputSchema(contract.inputSchema),
  successSchema: outputSchema(contract.successSchema),
  failureCodes: contract.failureCodes,
  failureSchema: outputSchema(applicationFailureSchemaFor(
    contract.applicationContract.errorRegistry,
    contract.failureCodes,
  )),
});

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

const canonicalManagementProjection = (): string => independentCanonicalJson(
  JSON.parse(JSON.stringify({
    internalContext: outputSchema(walletManagementInternalContextSchema),
    cancelOperation: managementContractProjection(walletManagementContracts.cancelOperation),
    connect: managementContractProjection(walletManagementContracts.connect),
    currentOperation: managementContractProjection(walletManagementContracts.currentOperation),
    disconnect: managementContractProjection(walletManagementContracts.disconnect),
    operation: managementContractProjection(walletManagementContracts.operation),
    confirmation: {
      contractVersion: walletOperationConfirmationContract.contractVersion,
      inputSchema: outputSchema(walletOperationConfirmationContract.inputSchema),
      successSchema: outputSchema(walletOperationConfirmationContract.successSchema),
      failureCodes: walletOperationConfirmationContract.failureCodes,
      failureSchema: outputSchema(applicationFailureSchemaFor(
        walletOperationConfirmationContract.errorRegistry,
        walletOperationConfirmationContract.failureCodes,
      )),
    },
  })) as CanonicalJson,
);

describe("wallet management contract authority", () => {
  it("uses the one canonical wallet error registry by exact reference", () => {
    for (const contract of Object.values(walletManagementContracts)) {
      expect(contract.applicationContract.errorRegistry).toBe(walletErrorRegistry);
      expect(contract.contractVersion).toBe(contract.applicationContract.contractVersion);
      expect(contract.contractVersion).toBe("1");
    }
    expect(walletOperationConfirmationContract.errorRegistry).toBe(walletErrorRegistry);
    expect(walletOperationConfirmationContract.contractVersion).toBe("1");
  });

  it("preserves the complete wallet management projection", () => {
    const canonical = canonicalManagementProjection();
    expect(Buffer.byteLength(canonical, "utf8")).toBe(136_324);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(
      "504e586534c1208d17f47454f6d6e5b9d16ccd859ff045dd8a587c5247be9a3c",
    );
  });

  it("uses the exact optional wallet interaction contract for internal context", () => {
    const validator = new Ajv2020({ strict: true }).compile(
      outputSchema(walletManagementInternalContextSchema),
    );
    for (const context of [{}, { interactionInterface: "cli" }, { interactionInterface: "web" }]) {
      expect(walletManagementInternalContextSchema.parse(context)).toEqual(context);
      expect(validator(context)).toBe(true);
    }
    for (const interactionInterface of ["mcp", "CLI", "browser", "", null]) {
      const context = { interactionInterface };
      expect(() => walletManagementInternalContextSchema.parse(context)).toThrow();
      expect(validator(context)).toBe(false);
    }
    expect(() => walletManagementInternalContextSchema.parse({
      interactionInterface: "web",
      extra: true,
    })).toThrow();
    expect(validator({ interactionInterface: "web", extra: true })).toBe(false);
  });

  it("declares fixed-owner contention as canonical management failures", () => {
    for (const contract of Object.values(walletManagementContracts)) {
      expect(contract.failureCodes).toContain("runtime_busy");
      expect(contract.failureCodes).toContain("port_conflict");
    }
  });

  it("projects exact start-kind and current-connection constraints into JSON Schema", () => {
    const validator = (schema: z.ZodType) =>
      new Ajv2020({ strict: true }).compile(z.toJSONSchema(schema, {
        target: "draft-2020-12",
        io: "output",
        unrepresentable: "throw",
      }));
    const current = {
      status: "current_connection",
      connectionRevision: "7",
      connection: connected,
    };
    const started = (kind: WalletOperationKind) => ({
      status: "operation_started",
      operation: operation(kind),
    });

    const connect = validator(walletManagementContracts.connect.successSchema);
    expect(connect(current)).toBe(true);
    expect(connect(started("connect"))).toBe(true);
    expect(connect(started("disconnect"))).toBe(false);

    const disconnect = validator(walletManagementContracts.disconnect.successSchema);
    expect(disconnect(started("disconnect"))).toBe(true);
    expect(disconnect(current)).toBe(false);
    expect(disconnect(started("connect"))).toBe(false);
  });

  it("binds each start capability to its exact operation kind", () => {
    const connect = walletManagementContracts.connect;
    const disconnect = walletManagementContracts.disconnect;

    expect(connect.parsePublicSuccess({}, {
      status: "operation_started",
      operation: operation("connect"),
    })).toEqual({
      status: "operation_started",
      operation: operation("connect"),
    });
    expect(disconnect.parsePublicSuccess({}, {
      status: "operation_started",
      operation: operation("disconnect"),
    })).toEqual({
      status: "operation_started",
      operation: operation("disconnect"),
    });

    expect(() => connect.parsePublicSuccess({}, {
      status: "operation_started",
      operation: operation("disconnect"),
    })).toThrow();
    expect(() => disconnect.parsePublicSuccess({}, {
      status: "operation_started",
      operation: operation("connect"),
    })).toThrow();
    expect(Object.keys(walletManagementContracts).sort()).toEqual([
      "cancelOperation",
      "connect",
      "currentOperation",
      "disconnect",
      "operation",
    ]);
  });

  it("permits idempotent current connection only for connect", () => {
    const current = {
      status: "current_connection",
      connectionRevision: "7",
      connection: connected,
    };
    expect(walletManagementContracts.connect.parsePublicSuccess({}, current)).toEqual(current);
    expect(() => walletManagementContracts.disconnect.parsePublicSuccess({}, current)).toThrow();
  });

  it("binds operation and cancellation results to the requested operation identifier", () => {
    for (const contract of [
      walletManagementContracts.operation,
      walletManagementContracts.cancelOperation,
    ]) {
      const input = contract === walletManagementContracts.cancelOperation
        ? { operationId, connectionRevision: "7" }
        : { operationId };
      expect(contract.parsePublicSuccess(
        input,
        operation("connect"),
      )).toEqual(operation("connect"));
      expect(() => contract.parsePublicSuccess(
        input,
        operation("connect", otherOperationId),
      )).toThrow("does not match");
    }
  });
});
