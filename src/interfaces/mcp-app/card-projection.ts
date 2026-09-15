import { cardOperationProjectionSchema, type CardOperationProjection } from "./card-contract.js";
import { operationToolResultEvidence } from "./contracts.js";
import type { WalletManagementOperation } from "../../wallet/contracts.js";
import type { TokenCatalogOperation } from "../../token-catalog/client.js";

export const projectCardOperation = (
  operation: WalletManagementOperation | TokenCatalogOperation,
): CardOperationProjection => {
  const common = { operationId: operation.operationId,
    resultSha256: operationToolResultEvidence(operation).sha256,
    initiatedBy: operation.initiatedBy, actionExpiresAt: operation.review.actionExpiresAt };
  if (operation.domain === "wallet") {
    const connection = operation.state === "completed" ? operation.result.connection : operation.review.precondition.connection;
    return cardOperationProjectionSchema.parse({ ...common, kind: "wallet", action: operation.kind, state: operation.state,
      account: connection.status === "connected" ? { chainId: connection.chainId, address: connection.address } : null,
      connectionRevision: operation.state === "completed" ? operation.result.connectionRevision : null,
      peerRefusalCode: operation.state === "rejected" ? operation.peerRefusalCode : null,
      failureCode: operation.state === "failed" ? operation.failure.error.code : null,
    });
  }
  const selection = operation.result.selection.selection;
  return cardOperationProjectionSchema.parse({ ...common, kind: "token_selection", action: operation.kind, state: operation.state,
    account: selection.account, asset: selection.asset, included: selection.included,
    selectionRevision: selection.revision, completedAt: operation.completedAt,
  });
};
