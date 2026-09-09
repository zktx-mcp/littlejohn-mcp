import type { ObservationWriter, ObservationAuthority } from "../core/index.js";
import type { WalletSessionSource } from "../runtime/source-identity.js";
import type { ExchangePreparationDependencies } from "./preparation.js";
import type { selectTransactionContractFacts } from "../intelligence/transaction-facts.js";
import { transactionContractSourceClaim } from "../intelligence/transaction-contracts.js";
import type { ExchangeObservation } from "./observation.js";
import type { FeeReplacementObservation } from "./replacement-contract.js";
import { captureCanonicalJson } from "../core/index.js";
import { exchangeObservationEvidence, exchangeChainClaim, exchangeOfficialClaim, exchangeWalletClaim, exchangePendingNonceClaim, exchangeContractChainClaim } from "./evidence.js";
type TransactionObservation = ExchangeObservation | FeeReplacementObservation;
export const recordExchangeEvidence = (
  data: TransactionObservation,
  observations: ObservationWriter,
  dependencies: ExchangePreparationDependencies,
  session: WalletSessionSource,
  contracts: readonly ({ role: ExchangeObservation["contracts"][number]["role"] } & ReturnType<typeof selectTransactionContractFacts>)[],
): void => {
  const evidence = exchangeObservationEvidence;
  const record = (declaration: typeof evidence.chain.declaration, source: ObservationAuthority, value: ReturnType<typeof captureCanonicalJson>, anchored: boolean) => {
    const target = observations.bind(declaration);
    observations.record(target.slot, { source, claims: [{ role: target.roles.value, value, ...(anchored ? { chainAnchor: data.block } : {}) }] });
  };
  record(evidence.chain.declaration, dependencies.reads.observationAuthority, exchangeChainClaim(data), true);
  if (data.official !== null) record(evidence.official.declaration, dependencies.officialAssetObservationAuthority, exchangeOfficialClaim(data), false);
  record(evidence.wallet.declaration, session.observationAuthority, exchangeWalletClaim(data), false);
  record(evidence.pending.declaration, dependencies.transactions.observationAuthority, exchangePendingNonceClaim(data), false);
  for (const entry of contracts) {
    const targets = evidence.contracts.find(({ role }) => role === entry.role)!;
    record(targets.chain.declaration, dependencies.reads.observationAuthority, exchangeContractChainClaim(entry.facts), true);
    for (const source of entry.observations) record(targets[source.role].declaration, source.source, source.claim, true);
  }
};
