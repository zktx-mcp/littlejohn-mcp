import type {EvmAccountIdentity} from "../../../evm/identities.js";
import { receiptApplicationContracts } from "../../../receipt-activity/application-contracts.js";
import { operationToolInputEvidence } from "../contracts.js";
import { admitToolReply, applicationIssue } from "./tool-result.js";
import { admitExchangeConfirmationResult } from "../../../review/application-contracts.js";
import { activityToolContracts } from "../../exchange-tool-contracts.js";
import { walletOutcomeText, exchangeReviewSections, transactionRecordSections, transactionSectionsText } from "../../exchange-presentation.js";
import type { PresentationViewApp } from "./lifecycle.js";
import { renderOperationMessage, replaceOperationRegion, renderTransactionSections, renderViewIssue } from "./renderers.js";

export const mountTransactionResult = (
  app: PresentationViewApp, account: EvmAccountIdentity, operationId: string, value: unknown,
  article: HTMLElement, signal: AbortSignal,
): Promise<void> => {
  const result = admitExchangeConfirmationResult(operationId, value);
  const message = (title: string, body: string) => replaceOperationRegion(article,
    renderOperationMessage(title, body, "unavailable"));
  message(result.kind === "wallet_result" ? "Wallet result" : "A new decision is required",
    result.kind === "wallet_result" ? walletOutcomeText(result.outcome) : transactionSectionsText(exchangeReviewSections(result.review)));
  if (result.kind === "wallet_result" && result.outcome.status === "hash_returned" && result.outcome.recording === "recorded") {
    const input = { account, transactionHash: result.outcome.transactionHash };
    return (async () => {
      try {
        const read = await app.callServerTool({ name: activityToolContracts.get.mcp.name, arguments: input }, { signal });
        if (signal.aborted) return;
        const admitted = admitToolReply(read, { hostName: app.getHostVersion()?.name, toolName: activityToolContracts.get.mcp.name,
          inputEvidence: operationToolInputEvidence(input) }, {
          success: (value) => receiptApplicationContracts.get.parsePublicSuccess(input, value),
          failure: (value) => applicationIssue(receiptApplicationContracts.get.parseFailure(value)),
        });
        if (!admitted.ok) {
          // Keep the received Wallet/hash result; this failure belongs only to its detail read.
          article.querySelector(".operation-region")?.append(renderViewIssue(admitted.issue));
          return;
        }
        replaceOperationRegion(article, renderTransactionSections(transactionRecordSections(admitted.value)));
      } catch {
        if (!signal.aborted) message("Stored result unavailable", `${walletOutcomeText(result.outcome)} The local result could not be displayed; this does not change execution.`);
      }
    })();
  }
  return Promise.resolve();
};
