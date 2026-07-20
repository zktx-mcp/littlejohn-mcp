import { describe, expect, it } from "vitest";

import {
  tokenInspectionFields,
  tokenOperationCopy,
  tokenOperationNotification,
  tokenRegistrationLabel,
} from "../../../src/interfaces/web/token-catalog-view.js";
import {
  tokenCatalogOperationSchema,
  tokenInspectionDigest,
  tokenRegistrationSchema,
  type TokenCatalogOperationKind,
  type TokenCatalogOperationState,
} from "../../../src/token-catalog/browser.js";
import { TokenCatalogOperationError } from "../../../src/token-catalog/operation-error.js";
import { createInspectionSuccess, walletAddress } from "../../token-catalog/harness.js";

const operationFor = async (kind: TokenCatalogOperationKind, state: TokenCatalogOperationState) => {
  const inspection = await createInspectionSuccess();
  const registration = tokenRegistrationSchema.parse({
    account: { chainId: inspection.data.asset.chainId, address: walletAddress },
    asset: inspection.data.asset,
    revision: Buffer.alloc(16, 1).toString("base64url"),
    inspectionDigest: tokenInspectionDigest(inspection),
    createdAt: "2026-07-18T00:00:03.000Z",
  });
  const result = state !== "completed"
    ? null
    : kind === "unregister"
      ? { asset: registration.asset, removedRevision: registration.revision }
      : { registration, inspection };
  return tokenCatalogOperationSchema.parse({
    operationId: Buffer.alloc(32, kind === "register" ? 1 : 2).toString("base64url"),
    kind,
    state,
    interactionInterface: "web",
    createdAt: "2026-07-18T00:00:03.000Z",
    expiresAt: "2026-07-18T00:05:03.000Z",
    account: registration.account,
    connectionRevision: "1",
    asset: registration.asset,
    review: { previousRegistration: kind === "register" ? null : registration, inspection, reviewDigest: `0x${"ab".repeat(32)}` },
    result,
    failure: state === "failed" ? new TokenCatalogOperationError("state_conflict").failure : null,
  });
};

describe("token catalog browser presentation", () => {
  it("projects immutable inspection evidence and uses the token address as registration identity", async () => {
    const inspection = await createInspectionSuccess();
    const registration = tokenRegistrationSchema.parse({
      account: { chainId: inspection.data.asset.chainId, address: walletAddress },
      asset: inspection.data.asset,
      revision: Buffer.alloc(16, 1).toString("base64url"),
      inspectionDigest: tokenInspectionDigest(inspection),
      createdAt: "2026-07-18T00:00:03.000Z",
    });
    expect(tokenRegistrationLabel(registration)).toBe(registration.asset.address);
    expect(tokenInspectionFields(inspection)).toEqual([
      { label: "Name", value: "Example Token" },
      { label: "Symbol", value: "EXT" },
      { label: "Raw total supply", value: "1000000" },
      { label: "Decimals", value: "18" },
    ]);
  });

  it("maps both operation kinds and every state without an update-only branch", async () => {
    for (const kind of ["register", "unregister"] as const) {
      for (const state of ["awaiting_confirmation", "applying", "completed", "cancelled", "expired", "failed"] as const) {
        const operation = await operationFor(kind, state);
        const copy = tokenOperationCopy(operation);
        if (state === "awaiting_confirmation") expect(copy.heading).toBe(kind === "register" ? "Add token" : "Remove token");
        if (state === "completed") expect(copy.heading).toBe(kind === "register" ? "Token added" : "Token removed");
        const notice = tokenOperationNotification(operation);
        expect(notice === undefined).toBe(state === "awaiting_confirmation" || state === "applying");
        if (notice !== undefined) expect(notice).toMatchObject({ id: operation.operationId, ...copy });
      }
    }
  });
});
