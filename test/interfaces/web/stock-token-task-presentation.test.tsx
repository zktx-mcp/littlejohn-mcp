import { describe, expect, it } from "vitest";

import {
  parseEvmAddressInput,
} from "../../../src/core/browser.js";
import {
  presentStockTokenAddTask,
  presentStockTokenInformationTask,
  presentStockTokenRemoveTask,
  type StockTokenRemoveContext,
} from "../../../src/interfaces/web/stock-token-task-presentation.js";
import {
  tokenCatalogOperationSchema,
  type TokenCatalogOperation,
} from "../../../src/token-catalog/browser.js";
import { createTokenOperation } from "../../token-catalog/harness.js";
import {
  stockTokenAddContext as addContext,
  stockTokenAssetUid as assetUid,
  stockTokenCandidate as candidate,
  stockTokenExactResult as exactResult,
  stockTokenOfficialRevision as officialRevision,
  stockTokenSelection as selection,
} from "./stock-token-fixtures.js";

const withOfficialEvidence = (
  operation: TokenCatalogOperation,
): TokenCatalogOperation => {
  if (operation.kind !== "add" || operation.review.inspection === null) {
    throw new TypeError("Expected an addition review.");
  }
  return tokenCatalogOperationSchema.parse({
    ...operation,
    review: {
      ...operation.review,
      officialSnapshotRevision: officialRevision,
      officialEvidence: {
        assetUid,
        snapshotRevision: officialRevision,
        verificationBlock: operation.review.inspection.data.analysis.block,
      },
    },
  });
};


describe("Stock Token task presentation ownership", () => {
  it("keeps one candidate region while the owned addition advances", async () => {
    const awaiting = withOfficialEvidence(await createTokenOperation({
      kind: "add",
      state: "awaiting_confirmation",
    }));
    const applying = withOfficialEvidence(await createTokenOperation({
      kind: "add",
      state: "applying",
    }));

    expect(presentStockTokenAddTask({
      context: addContext,
      actionIntent: undefined,
      operation: null,
      delivery: undefined,
    })).toMatchObject({
      claimsOperation: false,
      presentation: {
        candidates: [candidate],
        addStatus: { status: "idle" },
        inputsLocked: false,
      },
    });
    expect(presentStockTokenAddTask({
      context: addContext,
      actionIntent: "starting_add",
      operation: null,
      delivery: undefined,
    })).toMatchObject({
      claimsOperation: false,
      presentation: {
        candidates: [candidate],
        addStatus: { status: "adding" },
        inputsLocked: true,
      },
    });
    expect(presentStockTokenAddTask({
      context: addContext,
      actionIntent: undefined,
      operation: awaiting,
      delivery: undefined,
    })).toMatchObject({
      claimsOperation: true,
      presentation: {
        candidates: [candidate],
        addStatus: { status: "adding" },
        dismissible: false,
      },
    });
    expect(presentStockTokenAddTask({
      context: addContext,
      actionIntent: undefined,
      operation: applying,
      delivery: undefined,
    })).toMatchObject({
      claimsOperation: true,
      presentation: {
        candidates: [candidate],
        addStatus: { status: "adding" },
        dismissible: false,
      },
    });
    expect(presentStockTokenAddTask({
      context: addContext,
      actionIntent: "closing_add",
      operation: awaiting,
      delivery: undefined,
    })).toMatchObject({
      claimsOperation: true,
      presentation: {
        candidates: [candidate],
        addStatus: { status: "adding" },
        dismissible: false,
      },
    });
  });

  it("never turns an unmatched or absent addition into a removal task", async () => {
    const remove = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
    });

    expect(presentStockTokenAddTask({
      context: undefined,
      actionIntent: undefined,
      operation: remove,
      delivery: undefined,
    })).toEqual({
      presentation: undefined,
      claimsOperation: false,
    });
    expect(presentStockTokenAddTask({
      context: addContext,
      actionIntent: undefined,
      operation: remove,
      delivery: undefined,
    })).toMatchObject({
      claimsOperation: false,
      presentation: {
        candidates: [candidate],
        addStatus: { status: "idle" },
      },
    });
  });

  it("keeps token information separate from the removal task", async () => {
    const remove = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
    });
    const exactRead = Object.freeze({
      status: "available" as const,
      selection,
      result: exactResult,
    });

    expect(presentStockTokenInformationTask(exactRead)).toMatchObject({
      presentation: { status: "available" },
    });
    const removeContext: StockTokenRemoveContext = Object.freeze({
      subject: Object.freeze({
        selection,
        name: "Example Stock Token",
      }),
    });
    expect(presentStockTokenRemoveTask({
      context: removeContext,
      actionIntent: "starting_remove",
      operation: null,
      delivery: undefined,
    })).toMatchObject({
      claimsOperation: false,
      presentation: {
        status: "preparing",
        subject: { name: "Example Stock Token" },
      },
    });
    expect(presentStockTokenRemoveTask({
      context: removeContext,
      actionIntent: undefined,
      operation: remove,
      delivery: undefined,
    })).toMatchObject({
      claimsOperation: true,
      presentation: { status: "ready" },
    });
    expect(presentStockTokenRemoveTask({
      context: removeContext,
      actionIntent: "closing_remove",
      operation: remove,
      delivery: undefined,
    })).toMatchObject({
      claimsOperation: true,
      presentation: { status: "closing" },
    });
  });

  it("does not let an unrelated removal claim either task", async () => {
    const remove = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
    });
    const otherSelection = Object.freeze({
      ...selection,
      asset: Object.freeze({
        ...selection.asset,
        address: parseEvmAddressInput(`0x${"99".repeat(20)}`),
      }),
    });

    expect(presentStockTokenInformationTask({ status: "idle" })).toEqual({
      presentation: undefined,
    });
    expect(presentStockTokenRemoveTask({
      context: {
        subject: { selection: otherSelection, name: "Other Stock Token" },
      },
      actionIntent: undefined,
      operation: remove,
      delivery: undefined,
    })).toEqual({
      presentation: {
        status: "preparing",
        subject: {
          selection: otherSelection,
          name: "Other Stock Token",
        },
      },
      claimsOperation: false,
    });
  });
});
