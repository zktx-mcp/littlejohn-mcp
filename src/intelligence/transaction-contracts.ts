import { z } from "zod";

import {
  captureCanonicalJson,
  contractAnalysisSchema,
  contractDeclaredFunctionCountLimit,
  contractDeclaredFunctionUtf16CodeUnitLimit,
  hash32Schema,
  isStrictlyOrderedUnique,
  jsonObject,
  type CanonicalJson,
} from "../core/client.js";

const fields = contractAnalysisSchema.shape;
export const transactionContractFactsSchema = jsonObject({
  chainId: fields.chainId,
  target: fields.target,
  block: fields.block,
  targetRuntimeCode: fields.targetRuntimeCode,
  proxy: fields.proxy,
  sources: fields.sources,
  controls: fields.controls,
  requiredFunctions: z.array(z.string().min(1).max(contractDeclaredFunctionUtf16CodeUnitLimit))
    .min(1).max(contractDeclaredFunctionCountLimit),
  functionStatus: z.enum(["declared", "missing", "unavailable"]),
  sourceAnalysisDigest: hash32Schema,
}).strict().superRefine((facts, context) => {
  if (facts.chainId !== facts.block.chainId || !isStrictlyOrderedUnique(facts.requiredFunctions)) {
    context.addIssue({ code: "custom", message: "Transaction contract facts have inconsistent scope." });
  }
  const target = facts.sources[0];
  const implementation = facts.sources[1];
  const resolved = facts.proxy.status === "resolved";
  if (target?.role !== "target" || target.address !== facts.target ||
      facts.sources.length !== (resolved ? 2 : 1) ||
      (facts.proxy.status === "resolved" && (implementation?.role !== "implementation" ||
        implementation.address !== facts.proxy.implementation))) {
    context.addIssue({ code: "custom", message: "Transaction source identities do not match their deployment." });
  }
  const available = facts.proxy.status !== "unresolved" &&
    (resolved ? implementation : target)?.status === "exact_match";
  if (available === (facts.functionStatus === "unavailable") ||
      (!available && Object.values(facts.controls).some((control) => control.status !== "unavailable"))) {
    context.addIssue({ code: "custom", message: "Transaction contract facts contradict source availability." });
  }
});
export type TransactionContractFacts = z.infer<typeof transactionContractFactsSchema>;

export const transactionContractSourceClaim = (
  facts: TransactionContractFacts,
  role: "target" | "implementation",
): CanonicalJson => {
  const source = facts.sources.find((entry) => entry.role === role);
  if (source === undefined) throw new TypeError("Transaction source role is absent.");
  const effective = facts.proxy.status === "resolved" ? "implementation" : "target";
  return captureCanonicalJson({
    chainId: facts.chainId, target: facts.target, source,
    sourceAnalysisDigest: facts.sourceAnalysisDigest,
    ...(role === effective ? { requiredFunctions: facts.requiredFunctions, functionStatus: facts.functionStatus } : {}),
  });
};

