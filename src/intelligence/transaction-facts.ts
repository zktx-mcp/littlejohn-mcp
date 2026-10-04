import {contractAnalysisSchema} from "./analysis-contract.js";
import {deepFreezeValue, parseHash32, canonicalSha256, captureCanonicalJson, type CanonicalJson, type ObservationAuthority} from "../core/index.js";
import type { ContractAnalysisExecution } from "./contract-analysis.js";
import { transactionContractFactsSchema, transactionContractSourceClaim, type TransactionContractFacts } from "./transaction-contracts.js";
export const selectTransactionContractFacts = (
  execution: ContractAnalysisExecution,
  requiredFunctions: readonly string[],
): Readonly<{
  facts: TransactionContractFacts;
  observations: readonly Readonly<{ role: "target" | "implementation"; source: ObservationAuthority; claim: CanonicalJson }>[];
}> => {
  const analysis = contractAnalysisSchema.parse(execution.analysis);
  const selected = [...requiredFunctions].sort();
  const functionStatus = analysis.declaredFunctions.status === "observed"
    ? selected.every((signature) => analysis.declaredFunctions.status === "observed" && analysis.declaredFunctions.signatures.includes(signature))
      ? "declared" : "missing"
    : "unavailable";
  const facts = deepFreezeValue(transactionContractFactsSchema.parse({
    chainId: analysis.chainId, target: analysis.target, block: analysis.block,
    targetRuntimeCode: analysis.targetRuntimeCode, proxy: analysis.proxy,
    sources: analysis.sources, controls: analysis.controls,
    requiredFunctions: selected, functionStatus,
    sourceAnalysisDigest: parseHash32(`0x${canonicalSha256(captureCanonicalJson(analysis))}`),
  }));
  return Object.freeze({
    facts,
    observations: Object.freeze(execution.sourceObservations.map((observation) => Object.freeze({
      role: observation.role,
      source: observation.observationAuthority,
      claim: transactionContractSourceClaim(facts, observation.role),
    }))),
  });
};
