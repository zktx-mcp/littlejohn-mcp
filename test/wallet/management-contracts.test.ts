import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { walletManagementContracts } from "../../src/wallet/management-contracts.js";
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
  account: "eip155:4663:0x1111111111111111111111111111111111111111",
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
  expiresAt: "2026-07-17T02:00:00.000Z",
  result: null,
  failure: null,
});

describe("wallet management contract authority", () => {
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

    expect(connect.parseSuccess({}, {
      status: "operation_started",
      operation: operation("connect"),
    })).toEqual({
      status: "operation_started",
      operation: operation("connect"),
    });
    expect(disconnect.parseSuccess({}, {
      status: "operation_started",
      operation: operation("disconnect"),
    })).toEqual({
      status: "operation_started",
      operation: operation("disconnect"),
    });

    expect(() => connect.parseSuccess({}, {
      status: "operation_started",
      operation: operation("disconnect"),
    })).toThrow();
    expect(() => disconnect.parseSuccess({}, {
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
    expect(walletManagementContracts.connect.parseSuccess({}, current)).toEqual(current);
    expect(() => walletManagementContracts.disconnect.parseSuccess({}, current)).toThrow();
  });

  it("binds operation and cancellation results to the requested operation identifier", () => {
    for (const contract of [
      walletManagementContracts.operation,
      walletManagementContracts.cancelOperation,
    ]) {
      expect(contract.parseSuccess(
        { operationId },
        operation("connect"),
      )).toEqual(operation("connect"));
      expect(() => contract.parseSuccess(
        { operationId },
        operation("connect", otherOperationId),
      )).toThrow("does not match");
    }
  });
});
