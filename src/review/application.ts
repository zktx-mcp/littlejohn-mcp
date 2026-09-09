import type { ObservationAuthority } from "../core/index.js";
import { createExchangeReviewMaterialStore } from "../runtime/exchange-review-material.js";
import type { ReviewPresentationSource } from "../runtime/presentation-snapshot.js";
import type { TransactionLedgerStore } from "../receipt-activity/contracts.js";
import { ReceiptActivity } from "../receipt-activity/application.js";
import { receiptApplicationContracts, type ReceiptActivityPort } from "../receipt-activity/application-contracts.js";
import type { EvmAbiCodec } from "../chain/index.js";
import type { WalletTransactionPort } from "../wallet/transaction-contract.js";
import { ExchangeCoordinator } from "./coordinator.js";
import { exchangeApplicationContracts, type ExchangeApplicationPort } from "./application-contracts.js";
import type { ExchangePreparationDependencies } from "./preparation.js";
import type { InvocationBoundaryPorts } from "../core/index.js";

export interface ExchangeApplication {
  readonly exchange: ExchangeApplicationPort;
  readonly activity: ReceiptActivityPort;
  readonly presentations: ReviewPresentationSource;
  close(): Promise<void>;
}

export const createExchangeApplication = (input: Readonly<{
  preparation: ExchangePreparationDependencies;
  receiptInvocationPorts: InvocationBoundaryPorts;
  nativeUnitAuthority: ObservationAuthority;
  codec: EvmAbiCodec;
  walletTransactions: WalletTransactionPort;
  ledger: TransactionLedgerStore;
}>): ExchangeApplication => {
  const materials = createExchangeReviewMaterialStore(input.preparation.clock);
  const receipts = new ReceiptActivity({ chain: { ...input.preparation, invocationPorts: input.receiptInvocationPorts },
    nativeUnitAuthority: input.nativeUnitAuthority, codec: input.codec }, input.ledger);
  const coordinator = new ExchangeCoordinator({ preparation: input.preparation, materials, wallet: input.walletTransactions, receipts });
  let closeWork: Promise<void> | undefined;
  return Object.freeze({
    exchange: Object.freeze({
      start: async (value, signal) => {
        const request = exchangeApplicationContracts.start.parseInput(value);
        return exchangeApplicationContracts.start.parsePublicSuccess(request, await coordinator.start(request, signal));
      },
      get: (operationId) => exchangeApplicationContracts.get.parsePublicSuccess({ operationId }, coordinator.get(operationId)),
      cancel: (operationId) => exchangeApplicationContracts.cancel.parsePublicSuccess({ operationId }, coordinator.cancel(operationId)),
      confirm: (value, signal) => coordinator.confirm(value, signal),
    } satisfies ExchangeApplicationPort),
    activity: Object.freeze({
      get: (value) => {
        const request = receiptApplicationContracts.get.parseInput(value);
        return receiptApplicationContracts.get.parsePublicSuccess(request, receipts.get(request.account, request.transactionHash));
      },
      list: (value) => {
        const request = receiptApplicationContracts.list.parseInput(value);
        const result = receipts.list(request.account, request.cursor?.after ?? null);
        return receiptApplicationContracts.list.parsePublicSuccess(request, { ...result,
          nextCursor: result.nextCursor === null ? null : { account: request.account, after: result.nextCursor } });
      },
      inspect: async (value, signal) => {
        const request = receiptApplicationContracts.inspect.parseInput(value);
        const result = await receipts.inspect(request.account, request.transactionHash, signal);
        return receiptApplicationContracts.inspect.parsePublicSuccess(request, { ...request,
          status: result.status, observation: result.record?.inspection?.data.status ?? null,
          recorded: receipts.get(request.account, request.transactionHash) !== null,
          failure: result.status === "unavailable" ? result.failure : null,
        });
      },
    } satisfies ReceiptActivityPort),
    presentations: Object.freeze({ readPresentation: (operationId: string) => materials.readPresentation(operationId) }),
    close(): Promise<void> {
      if (closeWork !== undefined) return closeWork;
      closeWork = (async () => {
        let failure: unknown;
        try { await coordinator.close(); } catch (error) { failure = error; }
        try { await receipts.close(); } catch (error) { failure ??= error; }
        if (failure !== undefined) throw failure;
      })();
      return closeWork;
    },
  });
};
