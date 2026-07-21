import { describe, expect, it } from "vitest";

import {
  tokenInspectionFields,
  tokenOperationCopy,
  tokenOperationNotification,
  tokenSelectionLabel,
} from "../../../src/interfaces/web/token-catalog-view.js";
import {
  type TokenCatalogOperationKind,
  type TokenCatalogOperationState,
} from "../../../src/token-catalog/browser.js";
import {
  createInspectionSuccess,
  createTokenOperation,
  createTokenSelection,
} from "../../token-catalog/harness.js";

const operationFor = async (kind: TokenCatalogOperationKind, state: TokenCatalogOperationState) => {
  return createTokenOperation({ kind, state });
};

describe("token catalog browser presentation", () => {
  it("projects immutable inspection evidence and uses the token address as selection identity", async () => {
    const inspection = await createInspectionSuccess();
    const selection = createTokenSelection(inspection);
    expect(tokenSelectionLabel(selection)).toBe(selection.asset.address);
    expect(tokenInspectionFields(inspection)).toEqual([
      { label: "Name", value: "Example Token" },
      { label: "Symbol", value: "EXT" },
      { label: "Raw total supply", value: "1000000" },
      { label: "Decimals", value: "18" },
    ]);
  });

  it("maps both operation kinds and every state without an update-only branch", async () => {
    for (const kind of ["add", "remove"] as const) {
      for (const state of ["awaiting_confirmation", "applying", "completed", "cancelled", "expired", "failed"] as const) {
        const operation = await operationFor(kind, state);
        const copy = tokenOperationCopy(operation);
        if (state === "awaiting_confirmation") expect(copy.heading).toBe(kind === "add" ? "Add token" : "Remove token");
        if (state === "completed") expect(copy.heading).toBe(kind === "add" ? "Token added" : "Token removed");
        const notice = tokenOperationNotification(operation);
        expect(notice === undefined).toBe(state === "awaiting_confirmation" || state === "applying");
        if (notice !== undefined) expect(notice).toMatchObject({ id: operation.operationId, ...copy });
      }
    }
  });
});
