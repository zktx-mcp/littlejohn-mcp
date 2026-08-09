import { describe, expect, it } from "vitest";

import {
  accountAssetApplicationContracts,
} from "../../../src/account-assets/browser.js";
import {
  evmChainIdSchema,
  parseEvmAddressInput,
} from "../../../src/core/browser.js";
import {
  presentStockTokenAddTask,
  presentStockTokenInformationTask,
  presentStockTokenOperationTask,
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

const operationTask = (
  operation: TokenCatalogOperation | null,
  actionIntent: Parameters<typeof presentStockTokenOperationTask>[0]["actionIntent"] = undefined,
) => presentStockTokenOperationTask({
  operation,
  account: addContext.form.account,
  pending: actionIntent !== undefined,
  actionIntent,
  delivery: undefined,
});

const exactResultWithClassification = (
  classification: typeof exactResult.asset.classification,
) => accountAssetApplicationContracts.exact.parsePublicSuccess(
  { asset: exactResult.asset.selection.asset, viewRevision: exactResult.viewRevision },
  {
    ...exactResult,
    asset: { ...exactResult.asset, classification },
  },
);

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
  it("derives confirmation and cancellation from exact operation, account, and request state", async () => {
    const awaiting = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
    });
    const expectedAccount = {
      chainId: awaiting.account.chainId,
      address: awaiting.account.address,
      connectionRevision: awaiting.connectionRevision,
    };
    const observations = [
      { account: undefined, status: "unobserved" },
      {
        account: { ...expectedAccount, chainId: evmChainIdSchema.parse("eip155:1") },
        status: "different_chain",
      },
      {
        account: {
          ...expectedAccount,
          address: parseEvmAddressInput(`0x${"98".repeat(20)}`),
        },
        status: "different_address",
      },
      {
        account: { ...expectedAccount, connectionRevision: "different" },
        status: "revision_changed",
      },
    ] as const;

    const exact = presentStockTokenOperationTask({
      operation: awaiting,
      account: expectedAccount,
      pending: false,
      actionIntent: undefined,
      delivery: undefined,
    });
    expect(exact).toMatchObject({
      account: { status: "exact" },
      request: { status: "idle" },
      actions: ["confirm", "cancel"],
      terminal: false,
    });
    for (const observation of observations) {
      expect(presentStockTokenOperationTask({
        operation: awaiting,
        account: observation.account,
        pending: false,
        actionIntent: undefined,
        delivery: undefined,
      })).toMatchObject({
        account: { status: observation.status },
        actions: ["cancel"],
      });
    }

    expect(presentStockTokenOperationTask({
      operation: awaiting,
      account: expectedAccount,
      pending: true,
      actionIntent: "confirming_remove",
      delivery: undefined,
    })).toMatchObject({
      request: { status: "pending", action: "confirm" },
      actions: [],
    });
    expect(presentStockTokenOperationTask({
      operation: awaiting,
      account: expectedAccount,
      pending: false,
      actionIntent: undefined,
      delivery: {
        task: "remove",
        result: {
          status: "delivery_unknown",
          action: "cancel",
          operationId: awaiting.operationId,
          resendAllowed: false,
        },
      },
    })).toMatchObject({
      request: { status: "delivery_unknown" },
      actions: [],
    });
  });

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
      operationTask: undefined,
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
      operationTask: undefined,
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
      operationTask: operationTask(awaiting),
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
      operationTask: operationTask(applying),
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
      operationTask: operationTask(awaiting, "closing_add"),
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
      operationTask: operationTask(remove),
      delivery: undefined,
    })).toEqual({
      presentation: undefined,
      claimsOperation: false,
    });
    expect(presentStockTokenAddTask({
      context: addContext,
      actionIntent: undefined,
      operationTask: operationTask(remove),
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
      taskId: 1,
      account: addContext.form.account,
      subject: Object.freeze({
        selection,
        name: "Example Stock Token",
      }),
    });
    expect(presentStockTokenRemoveTask({
      context: removeContext,
      actionIntent: "starting_remove",
      operationTask: undefined,
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
      operationTask: operationTask(remove),
      delivery: undefined,
    })).toMatchObject({
      claimsOperation: true,
      presentation: { status: "ready" },
    });
    expect(presentStockTokenRemoveTask({
      context: removeContext,
      actionIntent: "closing_remove",
      operationTask: operationTask(remove, "closing_remove"),
      delivery: undefined,
    })).toMatchObject({
      claimsOperation: true,
      presentation: { status: "closing" },
    });
  });

  it("distinguishes list absence from current-member verification unavailability", () => {
    const verified = exactResult.asset.classification;
    if (verified.kind !== "robinhood_stock_token") {
      throw new TypeError("Expected a verified Stock Token fixture.");
    }
    const custom = exactResultWithClassification({
      kind: "custom_erc20",
      snapshot: verified.snapshot,
    });
    const verificationUnavailable = exactResultWithClassification({
      kind: "classification_unavailable",
      cause: {
        kind: "stock_factory_verification_unavailable",
        snapshot: verified.snapshot,
        member: verified.member,
        reason: "source_unavailable",
      },
    });

    expect(presentStockTokenInformationTask({
      status: "available",
      selection,
      result: custom,
    })).toMatchObject({
      presentation: {
        status: "classification_mismatch",
        message: "This token is not available in the current Stock Token list.",
      },
    });
    expect(presentStockTokenInformationTask({
      status: "available",
      selection,
      result: verificationUnavailable,
    })).toMatchObject({
      presentation: {
        status: "classification_mismatch",
        message: "Chain evidence required for StockFactory verification was unavailable.",
      },
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
        taskId: 1,
        account: addContext.form.account,
        subject: { selection: otherSelection, name: "Other Stock Token" },
      },
      actionIntent: undefined,
      operationTask: operationTask(remove),
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

  it("claims add and remove tasks only for their exact connected-account revision", async () => {
    const addition = withOfficialEvidence(await createTokenOperation({
      kind: "add",
      state: "awaiting_confirmation",
    }));
    const removal = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
    });
    const changedAddition = tokenCatalogOperationSchema.parse({
      ...addition,
      connectionRevision: "2",
    });
    const changedRemoval = tokenCatalogOperationSchema.parse({
      ...removal,
      connectionRevision: "2",
    });

    expect(presentStockTokenAddTask({
      context: addContext,
      actionIntent: undefined,
      operationTask: operationTask(changedAddition),
      delivery: undefined,
    }).claimsOperation).toBe(false);
    expect(presentStockTokenRemoveTask({
      context: {
        taskId: 1,
        account: addContext.form.account,
        subject: { selection, name: "Example Stock Token" },
      },
      actionIntent: undefined,
      operationTask: operationTask(changedRemoval),
      delivery: undefined,
    }).claimsOperation).toBe(false);
  });
});
