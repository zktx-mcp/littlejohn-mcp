import { canonicalFailureCodes, semanticReadFailureCodes } from "../core/client.js";
import {walletAccountResolutionFailureCodes} from "../wallet/error-definitions.js";

export const rpcReadFailureCodes = canonicalFailureCodes([
  ...semanticReadFailureCodes,
  "chain_response_unavailable",
  "rate_limited",
  "source_inconsistent",
  "source_unavailable",
]);

export const addressTargetReadFailureCodes = canonicalFailureCodes([
  ...rpcReadFailureCodes,
  ...walletAccountResolutionFailureCodes,
]);
