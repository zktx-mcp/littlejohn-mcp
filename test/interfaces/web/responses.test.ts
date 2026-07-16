import { describe, expect, it } from "vitest";

import {
  createOperationControlResponse,
  createOperationReadResponse,
  createQrResponse,
  parseOperationControlResponse,
  parseOperationReadResponse,
  parseQrResponse,
} from "../../../src/interfaces/browser-responses.js";
import { parseWalletManagementOperation } from "../../../src/wallet/operation-contract.js";

const operationId = "A".repeat(43);
const operation = Object.freeze({
  operationId,
  kind: "connect",
  state: "awaiting_confirmation",
  connectionRevision: "1",
  expiresAt: "2026-07-15T06:00:00.000Z",
  result: null,
  failure: null,
});

describe("browser response envelopes", () => {
  it("keeps operation reads and operation controls as distinct exact envelopes", () => {
    expect(createOperationReadResponse(operation, "interactive"))
      .toEqual({ operation, access: "interactive" });
    expect(createOperationControlResponse(operation)).toEqual({ operation });
    expect(parseOperationReadResponse({ operation, access: "interactive" }, operationId))
      .toEqual({ operation, access: "interactive" });
    expect(parseOperationControlResponse({ operation }, operationId)).toEqual({ operation });

    expect(() => parseOperationReadResponse({ operation }, operationId)).toThrow();
    expect(() => parseOperationControlResponse({ operation, access: "interactive" }, operationId)).toThrow();
    expect(() => parseOperationReadResponse({ operation, access: "owner" }, operationId)).toThrow();
    expect(() => parseOperationReadResponse({ operation, access: "read_only", extra: true }, operationId)).toThrow();
    expect(() => parseOperationReadResponse(
      { operation, access: "read_only" },
      "Q".repeat(43),
    )).toThrow(/requested operation/iu);
  });

  it("accepts only one plain QR envelope", () => {
    const qr = { size: 21, rows: Array.from({ length: 21 }, () => "0".repeat(21)) };
    expect(createQrResponse(qr)).toEqual({ qr });
    expect(parseQrResponse({ qr })).toEqual({ qr });
    expect(() => parseQrResponse({ qr, pairingUri: "secret" })).toThrow();
    expect(() => parseQrResponse({ qr: "not-a-matrix" })).toThrow();
  });

  it("delegates operation and QR internals to the canonical browser-safe parsers", () => {
    const failure = Object.freeze({
      ok: false,
      error: Object.freeze({
        code: "wallet_timeout",
        category: "wallet",
        message: "The wallet request timed out.",
        retryable: true,
        issues: Object.freeze([]),
      }),
    });
    const malformedOperations = [
      {},
      { ...operation, state: "made_up" },
      { ...operation, operationId: "not-an-operation-id" },
      { ...operation, connectionRevision: "-1" },
      { ...operation, connectionRevision: "01" },
      { ...operation, expiresAt: "2026-07-15T06:00:00Z" },
      { ...operation, state: "completed", result: null },
      { ...operation, state: "failed", failure: { ...failure, error: { ...failure.error, message: "forged" } } },
      { ...operation, state: "failed", failure: { ...failure, error: { ...failure.error, retryable: false } } },
      { ...operation, state: "failed", failure: { ...failure, secret: "leak" } },
    ];
    for (const malformed of malformedOperations) {
      expect(() => parseWalletManagementOperation(malformed)).toThrow();
      expect(() => parseOperationReadResponse(
        { operation: malformed, access: "read_only" },
        operationId,
      )).toThrow();
    }

    const connectedOperation = {
      ...operation,
      state: "completed",
      result: {
        outcome: "connected",
        connection: {
          status: "connected",
          account: "eip155:4663:0x1111111111111111111111111111111111111111",
          address: "0x1111111111111111111111111111111111111111",
          chainId: "eip155:4663",
          approvedMethods: ["eth_sendTransaction"],
          approvedEvents: ["accountsChanged", "chainChanged"],
          expiresAt: "2026-07-15T06:10:00.000Z",
        },
      },
    };
    for (const connection of [
      {
        ...connectedOperation.result.connection,
        account: "eip155:4663:0x2222222222222222222222222222222222222222",
      },
      { ...connectedOperation.result.connection, approvedMethods: [] },
      { ...connectedOperation.result.connection, approvedEvents: ["chainChanged", "accountsChanged"] },
      {
        ...connectedOperation.result.connection,
        approvedEvents: ["accountsChanged", "accountsChanged", "chainChanged"],
      },
    ]) expect(() => parseOperationControlResponse({
      operation: { ...connectedOperation, result: { outcome: "connected", connection } },
    }, operationId)).toThrow();

    for (const qr of [
      {},
      { size: 20, rows: Array.from({ length: 20 }, () => "0".repeat(20)) },
      { size: 21, rows: Array.from({ length: 20 }, () => "0".repeat(21)) },
      { size: 21, rows: Array.from({ length: 21 }, () => "0".repeat(20)) },
      { size: 21, rows: Array.from({ length: 21 }, () => "x".repeat(21)) },
    ]) expect(() => parseQrResponse({ qr })).toThrow();
  });

  it("rejects hostile response properties without evaluating them", () => {
    let evaluated = false;
    const hostile = { operation, access: "read_only" };
    Object.defineProperty(hostile, "operation", {
      enumerable: true,
      get() {
        evaluated = true;
        throw new Error("secret");
      },
    });
    expect(() => parseOperationReadResponse(hostile, operationId)).toThrow();
    expect(evaluated).toBe(false);
  });
});
