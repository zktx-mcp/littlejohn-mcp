import type { ObservationAuthority } from "../core/index.js";
import { createRequestReviewMaterialStore } from "../runtime/request-review-material.js";
import type { ReviewPresentationSource } from "../runtime/presentation-snapshot.js";
import type { TransactionLedgerStore } from "../receipt-activity/contracts.js";
import { ReceiptActivity } from "../receipt-activity/application.js";
import { receiptApplicationContracts, type ReceiptActivityPort } from "../receipt-activity/application-contracts.js";
import type { EvmAbiCodec } from "../chain/index.js";
import type { WalletRequestPort } from "../wallet/request-contract.js";
import { ExchangeCoordinator } from "./coordinator.js";
import { exchangeApplicationContracts, type ExchangeApplicationPort } from "./application-contracts.js";
import type { ExchangePreparationDependencies } from "./preparation.js";
import type { InvocationBoundaryPorts } from "../core/index.js";
import type { SigningCodec } from "../chain/signing-port.js";
import { SigningCoordinator } from "./signing-coordinator.js";
import { signingApplicationContracts, type SigningApplicationPort } from "./signing-application-contracts.js";

export interface ReviewApplication {
  readonly exchange: ExchangeApplicationPort;
  readonly signing: SigningApplicationPort;
  readonly activity: ReceiptActivityPort;
  readonly presentations: ReviewPresentationSource;
  close(): Promise<void>;
}

export const createReviewApplication = (input: Readonly<{
  preparation: ExchangePreparationDependencies;
  receiptInvocationPorts: InvocationBoundaryPorts;
  nativeUnitAuthority: ObservationAuthority;
  codec: EvmAbiCodec;
  signingCodec: SigningCodec;
  walletRequests: WalletRequestPort;
  ledger: TransactionLedgerStore;
}>): ReviewApplication => {
  const materials = createRequestReviewMaterialStore(input.preparation.clock);
  const receipts = new ReceiptActivity({ chain: { ...input.preparation, invocationPorts: input.receiptInvocationPorts },
    nativeUnitAuthority: input.nativeUnitAuthority, codec: input.codec }, input.ledger);
  const coordinator = new ExchangeCoordinator({ preparation: input.preparation, materials, wallet: input.walletRequests, receipts });
  const signing = new SigningCoordinator({ clock: input.preparation.clock, activeWallet: input.preparation.activeWallet,
    codec: input.signingCodec, materials, wallet: input.walletRequests });
  let closeWork: Promise<void> | undefined;
  return Object.freeze({
    signing: Object.freeze({
      start: async (value, signal) => {
        const command = signingApplicationContracts.start.parseInput(value);
        return signingApplicationContracts.start.parsePublicSuccess(command, await signing.start(command, signal));
      },
      get: (operationId) => signingApplicationContracts.get.parsePublicSuccess({ operationId }, { operationId, review: signing.get(operationId) }),
      cancel: (operationId) => signingApplicationContracts.cancel.parsePublicSuccess({ operationId }, signing.cancel(operationId)),
      confirm: (value, signal) => signing.confirm(value, signal),
    } satisfies SigningApplicationPort),
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
        try { await signing.close(); } catch (error) { failure = error; }
        try { await coordinator.close(); } catch (error) { failure ??= error; }
        try { await receipts.close(); } catch (error) { failure ??= error; }
        if (failure !== undefined) throw failure;
      })();
      return closeWork;
    },
  });
};
