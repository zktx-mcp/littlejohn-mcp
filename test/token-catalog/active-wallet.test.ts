import { describe, expect, it } from "vitest";

import {
  parseCapabilityDataAt,
  parseUnsignedDecimal,
  walletConnectionDataSchema,
  walletConnectionCapability,
} from "../../src/core/index.js";
import { captureConnectedWalletSession } from "../../src/token-catalog/active-wallet.js";
import { getTokenCatalogOperationFailure } from "../../src/token-catalog/operation-error.js";
import type { ActiveWalletReadPort } from "../../src/wallet/coordinator.js";
import { chainId, walletAddress } from "./harness.js";

const connected = parseCapabilityDataAt(walletConnectionCapability, {
  status: "connected",
  chainId,
  address: walletAddress,
  approvedMethods: ["eth_sendTransaction"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt: "2026-07-19T00:00:00.000Z",
}, "2026-07-18T00:00:03.000Z");

const sessionSource = Object.freeze({}) as NonNullable<
  ReturnType<ActiveWalletReadPort["capture"]>["sessionSource"]
>;
const connectionRevision = parseUnsignedDecimal("0");

const failureCode = (operation: () => unknown): string | undefined => {
  try { operation(); }
  catch (error) { return getTokenCatalogOperationFailure(error)?.error.code; }
  return undefined;
};

describe("token catalog connected wallet session", () => {
  it("captures the active wallet once and returns its canonical account and session source", () => {
    let captures = 0;
    const activeWallet: ActiveWalletReadPort = {
      capture: () => {
        captures += 1;
        return { connection: connected, connectionRevision, sessionSource };
      },
    };

    const result = captureConnectedWalletSession(activeWallet);

    expect(captures).toBe(1);
    expect(result).toEqual({
      account: { chainId, address: walletAddress },
      connectionRevision,
      sessionSource,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.account)).toBe(true);
  });

  it.each([
    [{ status: "disconnected", reason: "no_session" }, "wallet_not_connected"],
    [{ status: "disconnected", reason: "expired" }, "wallet_not_connected"],
    [{ status: "disconnected", reason: "deleted" }, "wallet_not_connected"],
    [{ status: "disconnected", reason: "disconnected" }, "wallet_not_connected"],
    [{ status: "disconnected", reason: "unusable_store" }, "wallet_session_unusable"],
    [{ status: "unknown", reason: "reconciling" }, "wallet_session_unusable"],
    [{ status: "unknown", reason: "owner_unavailable" }, "wallet_session_unusable"],
    [{ status: "unresolved", sessionCount: "2" }, "wallet_session_unusable"],
  ] as const)("maps %o to %s", (connection, expectedCode) => {
    expect(failureCode(() => captureConnectedWalletSession({
      capture: () => ({
        connection: walletConnectionDataSchema.parse(connection),
        connectionRevision,
      }),
    }))).toBe(expectedCode);
  });

  it("rejects a connected projection without a live session source", () => {
    expect(failureCode(() => captureConnectedWalletSession({
      capture: () => ({ connection: connected, connectionRevision }),
    }))).toBe("wallet_session_unusable");
  });
});
