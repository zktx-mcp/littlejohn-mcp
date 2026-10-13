import { presentationCopy as copy, statusCopy } from "../../presentation-copy.js";
import type {EvmAccountIdentity} from "../../../evm/identities.js";
import { receiptApplicationContracts } from "../../../receipt-activity/application-contracts.js";
import { operationToolInputEvidence } from "../contracts.js";
import { admitToolReply, applicationIssue } from "./tool-result.js";
import { admitExchangeConfirmationResult } from "../../../review/application-contracts.js";
import { activityToolContracts } from "../../exchange-tool-contracts.js";
import { exchangeReviewSections, transactionRecordSections } from "../../exchange-presentation.js";
import type { PresentationViewApp } from "./lifecycle.js";
import { replaceOperationRegion, presentTerminalResult, renderStatus, renderTransactionSections, renderReadFailure } from "./renderers.js";

export const mountTransactionResult = (
  app: PresentationViewApp, account: EvmAccountIdentity, operationId: string, value: unknown,
  article: HTMLElement, signal: AbortSignal,
): Promise<void> => {
  const result = admitExchangeConfirmationResult(operationId, value);
  if (result.kind === "wallet_result") {
    const state = result.outcome.status === "wallet_rejected" ? statusCopy.rejected : statusCopy[result.outcome.status];
    if (result.outcome.status === "delivery_unknown") replaceOperationRegion(article, renderStatus(state));
    else {
      const node = renderStatus(state);
      if (result.outcome.status === "hash_returned") {
        const hash = document.createElement("p"); hash.className = "field-value";
        hash.textContent = `${copy.label.transactionHash}: ${result.outcome.transactionHash}`;
        node.append(hash);
      }
      presentTerminalResult(article, node);
    }
  } else presentTerminalResult(article, renderTransactionSections(exchangeReviewSections(result.review)));
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
          article.querySelector(".operation-region")?.append(renderReadFailure("details", admitted.issue));
          return;
        }
        if (admitted.value === null) {
          article.querySelector(".operation-region")?.append(renderReadFailure("details", undefined));
          return;
        }
        presentTerminalResult(article, renderTransactionSections(transactionRecordSections(admitted.value)));
      } catch {
        if (!signal.aborted) article.querySelector(".operation-region")?.append(renderReadFailure("details", undefined));
      }
    })();
  }
  return Promise.resolve();
};
