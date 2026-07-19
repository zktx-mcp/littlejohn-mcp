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
  type TokenCatalogOperation,
  type TokenCatalogOperationKind,
  type TokenCatalogOperationState,
  type TokenInspectionSuccess,
  type TokenRegistration,
} from "../../../src/token-catalog/browser.js";
import { TokenCatalogOperationError } from "../../../src/token-catalog/operation-error.js";
import {
  createInspectionSuccess,
  walletAddress,
} from "../../token-catalog/harness.js";

const createdAt = "2026-07-18T00:00:03.000Z";
const expiresAt = "2026-07-18T00:05:03.000Z";

const registrationFor = (
  inspection: TokenInspectionSuccess,
  options: Readonly<{
    userLabel: string | null;
    visibility: "visible" | "hidden";
    revisionByte: number;
    updatedAt?: string;
  }>,
): TokenRegistration => tokenRegistrationSchema.parse({
  account: { chainId: inspection.data.asset.chainId, address: walletAddress },
  asset: inspection.data.asset,
  revision: Buffer.alloc(16, options.revisionByte).toString("base64url"),
  inspectionDigest: tokenInspectionDigest(inspection),
  userLabel: options.userLabel,
  visibility: options.visibility,
  createdAt,
  updatedAt: options.updatedAt ?? createdAt,
});

const operationFor = (
  inspection: TokenInspectionSuccess,
  kind: TokenCatalogOperationKind,
  state: TokenCatalogOperationState,
): TokenCatalogOperation => {
  const previous = kind === "register"
    ? null
    : registrationFor(inspection, {
        userLabel: "Old label",
        visibility: "visible",
        revisionByte: 1,
      });
  const proposedSettings = kind === "unregister"
    ? null
    : {
        userLabel: kind === "register" ? "New token" : "New label",
        visibility: kind === "register" ? "visible" as const : "hidden" as const,
      };
  const result = state !== "completed"
    ? null
    : kind === "unregister"
      ? { asset: inspection.data.asset, removedRevision: previous!.revision }
      : {
          registration: registrationFor(inspection, {
            userLabel: proposedSettings!.userLabel,
            visibility: proposedSettings!.visibility,
            revisionByte: 2,
            ...(kind === "register" ? {} : { updatedAt: "2026-07-18T00:00:04.000Z" }),
          }),
          inspection,
        };
  return tokenCatalogOperationSchema.parse({
    operationId: Buffer.alloc(32, kind === "register" ? 1 : kind === "update_registration" ? 2 : 3)
      .toString("base64url"),
    kind,
    state,
    interactionInterface: "web",
    createdAt,
    expiresAt,
    account: { chainId: inspection.data.asset.chainId, address: walletAddress },
    asset: inspection.data.asset,
    review: {
      previousRegistration: previous,
      proposedSettings,
      inspection,
      reviewDigest: `0x${"ab".repeat(32)}`,
    },
    result,
    failure: state === "failed"
      ? new TokenCatalogOperationError("state_conflict").failure
      : null,
  });
};

describe("token catalog browser presentation", () => {
  it("renders the inspected raw quantity and decimals without numeric reinterpretation", async () => {
    const inspection = await createInspectionSuccess();

    expect(tokenInspectionFields(inspection)).toEqual([
      { label: "Name", value: "Example Token" },
      { label: "Symbol", value: "EXT" },
      { label: "Raw total supply", value: "1000000" },
      { label: "Decimals", value: "18" },
    ]);
  });

  it("uses the user label when present and the exact address otherwise", async () => {
    const inspection = await createInspectionSuccess();
    const labeled = registrationFor(inspection, {
      userLabel: "My token",
      visibility: "visible",
      revisionByte: 1,
    });
    const unlabeled = registrationFor(inspection, {
      userLabel: null,
      visibility: "visible",
      revisionByte: 2,
    });

    expect(tokenRegistrationLabel(labeled)).toBe("My token");
    expect(tokenRegistrationLabel(unlabeled)).toBe(unlabeled.asset.address);
  });

  it("maps every canonical operation kind and state to exact user-facing copy", async () => {
    const inspection = await createInspectionSuccess();
    const headings = {
      register: { awaiting_confirmation: "Add token", completed: "Token added" },
      update_registration: { awaiting_confirmation: "Edit token", completed: "Token updated" },
      unregister: { awaiting_confirmation: "Remove token", completed: "Token removed" },
    } as const;
    const kinds = ["register", "update_registration", "unregister"] as const;
    const states = [
      "awaiting_confirmation",
      "applying",
      "completed",
      "cancelled",
      "expired",
      "failed",
    ] as const;

    for (const kind of kinds) {
      for (const state of states) {
        const operation = operationFor(inspection, kind, state);
        const copy = tokenOperationCopy(operation);
        const expectedHeading = state === "awaiting_confirmation" || state === "completed"
          ? headings[kind][state]
          : state === "applying"
            ? "Applying token catalog change"
            : state === "cancelled"
              ? "Token catalog change cancelled"
              : state === "expired"
                ? "Token catalog change expired"
                : "Token catalog change failed";
        expect(copy.heading).toBe(expectedHeading);
        const expectedMessage = operation.state === "failed"
          ? operation.failure.error.message
          : state === "awaiting_confirmation"
            ? "Review this account-specific catalog change before confirming."
            : state === "applying"
              ? "Little John is committing the confirmed change."
              : state === "completed"
                ? "The account-specific token catalog is up to date."
                : state === "cancelled"
                  ? "No catalog change was made by this operation."
                  : "The review expired before confirmation.";
        expect(copy.message).toBe(expectedMessage);
      }
    }
  });

  it("publishes only terminal operations with the canonical tone and copy", async () => {
    const inspection = await createInspectionSuccess();
    expect(tokenOperationNotification(
      operationFor(inspection, "register", "awaiting_confirmation"),
    )).toBeUndefined();
    expect(tokenOperationNotification(
      operationFor(inspection, "register", "applying"),
    )).toBeUndefined();

    const terminalStates = ["completed", "cancelled", "expired", "failed"] as const;
    for (const state of terminalStates) {
      const operation = operationFor(inspection, "register", state);
      const notice = tokenOperationNotification(operation);
      expect(notice).toEqual({
        id: operation.operationId,
        tone: state === "completed" ? "success" : state === "cancelled" ? "neutral" : "error",
        ...tokenOperationCopy(operation),
      });
    }
  });
});
