export {
  analyzeContract,
  assertContractAnalysisExecutionForTarget,
  isContractAnalysisTargetNotFoundError,
  recordContractAnalysisEvidence,
} from "./contract-analysis.js";
export type {
  ContractAnalysisExecution,
  ContractAnalysisSourceObservation,
} from "./contract-analysis.js";
export type {
  ContractAnalysisChainReadPort,
  ContractReadResult,
  ContractRuntimeCode,
  ContractSourceVerification,
  ContractSourceVerificationPort,
  ContractSourceVerificationRequest,
  ContractStorageAddress,
  Eip1967ProxyStorage,
} from "./ports.js";
export {
  createContractSourceVerificationPort,
} from "./ports.js";

export { createContractAnalysisEvidenceDeclaration, createContractAnalysisEvidenceFactsDeclaration, createContractAnalysisEvidenceConclusions, createContractAnalysisEvidenceFragment } from "./analysis-evidence.js";
export type { ContractAnalysisEvidenceTargets, ContractAnalysisEvidenceFactsDeclaration, ContractAnalysisEvidenceConclusions, ContractAnalysisEvidenceFragment } from "./analysis-evidence.js";

export { contractProxyMethods, contractProxyUnresolvedReasons, contractSourceVerificationStatuses, contractControlFailureReasons, contractDefaultAdminMemberLimit, contractDeclaredFunctionCountLimit, contractDeclaredFunctionUtf16CodeUnitLimit, contractRuntimeCodeIdentitySchema, contractProxyResultSchema, contractAnalysisSchema, createContractAnalysisSourceClaim, createContractAnalysisChainClaims, assertContractAnalysisForTarget, exactContractInterfaceSchema, contractControlInterfaceDefinitions } from "./analysis-contract.js";
export type { ContractRuntimeCodeIdentity, ContractProxyResult, ContractAnalysis, ContractSourceVerificationStatus, ContractControlFailureReason, ContractAnalysisTarget, ExactContractInterface, ContractControlFunctionDefinition, ContractControlEventDefinition, ContractSourceAddress } from "./analysis-contract.js";
