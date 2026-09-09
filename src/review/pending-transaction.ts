import { dynamicFeeRequestCommitment, type EvmAccountIdentity, type Hash32 } from "../core/index.js";
import { dynamicFeeRequestFromTransaction } from "../chain/transaction-reads.js";
import type { ChainInvocationContext } from "../chain/invocation-lifecycle.js";
import type { ExchangePreparationDependencies } from "./preparation.js";
import { pendingReplacementSchema } from "./pending-contract.js";
import { ExchangeError } from "./errors.js";

export const readPendingReplacement = async (
  dependencies: ExchangePreparationDependencies,
  context: ChainInvocationContext,
  hash: Hash32,
  account: EvmAccountIdentity,
) => {
  const observed = await dependencies.transactions.readTransaction(context, hash);
  if (observed.status !== "pending" || observed.transaction.chainScope !== account.chainId ||
      observed.transaction.from !== account.address) throw new ExchangeError("exchange_replacement_unavailable");
  try {
    const request = dynamicFeeRequestFromTransaction(observed.transaction);
    const conditions = dependencies.evm.decodeCall(request, account.address);
    const deadline = conditions.kind === "swap" ? conditions.deadline :
      conditions.kind === "permit2_approval" ? conditions.expiration : null;
    if (deadline !== null && dependencies.clock.now() >= deadline) throw new ExchangeError("exchange_replacement_unavailable");
    const reference = pendingReplacementSchema.parse({
      transactionHash: hash, walletRequestCommitment: dynamicFeeRequestCommitment(request),
      nonce: request.nonce, gasLimit: request.gasLimit,
      fees: { maxFeePerGas: request.maxFeePerGas, maxPriorityFeePerGas: request.maxPriorityFeePerGas },
    });
    return Object.freeze({ request, reference, conditions, deadline });
  } catch (error) {
    if (error instanceof ExchangeError) throw error;
    throw new ExchangeError("exchange_replacement_unavailable");
  }
};
