import type {
  chainErrorDefinitions,
  chainInterfaceErrorMappingDefinitions,
} from "../chain/error-definitions.js";
import type {
  OfficialAssetSourceUnavailableReason,
  StockFactoryClassificationUnavailableReason,
} from "./client.js";
import type {
  runtimeErrorDefinitions,
  runtimeInterfaceErrorMappingDefinitions,
} from "../runtime/error-definitions.js";

export const officialAssetErrorDefinitions = Object.freeze([
  {
    code: "official_asset_response_unavailable",
    category: "transport",
    message: "A complete official asset response was not obtained.",
    retryable: true,
  },
  {
    code: "official_asset_response_too_large",
    category: "domain",
    message: "The official asset response exceeds the supported size.",
    retryable: false,
  },
  {
    code: "factory_identity_mismatch",
    category: "source",
    message: "The StockFactory deployment identity did not match the admitted identity.",
    retryable: false,
  },
  {
    code: "token_code_missing",
    category: "source",
    message: "No runtime code was found at the mapped token address.",
    retryable: false,
  },
  {
    code: "token_identity_mismatch",
    category: "source",
    message: "The StockFactory UID mapping did not match the official token address.",
    retryable: false,
  },
] as const);

export const officialAssetInterfaceErrorMappingDefinitions = Object.freeze([
  { code: "official_asset_response_unavailable", httpStatus: 502, problemTitle: "Official asset response unavailable", cliExitCode: 4 },
  { code: "official_asset_response_too_large", httpStatus: 502, problemTitle: "Official asset response too large", cliExitCode: 4 },
  { code: "factory_identity_mismatch", httpStatus: 502, problemTitle: "StockFactory identity mismatch", cliExitCode: 4 },
  { code: "token_code_missing", httpStatus: 502, problemTitle: "Token code missing", cliExitCode: 4 },
  { code: "token_identity_mismatch", httpStatus: 502, problemTitle: "Token identity mismatch", cliExitCode: 4 },
] as const);

type RequiredExternalFailureCode =
  | OfficialAssetSourceUnavailableReason
  | StockFactoryClassificationUnavailableReason;
type AdmittedExternalFailureDefinitionCode =
  | (typeof runtimeErrorDefinitions)[number]["code"]
  | (typeof chainErrorDefinitions)[number]["code"]
  | (typeof officialAssetErrorDefinitions)[number]["code"];
type AdmittedExternalFailureMappingCode =
  | (typeof runtimeInterfaceErrorMappingDefinitions)[number]["code"]
  | (typeof chainInterfaceErrorMappingDefinitions)[number]["code"]
  | (typeof officialAssetInterfaceErrorMappingDefinitions)[number]["code"];

const externalFailureContractsAreComplete: [
  Exclude<RequiredExternalFailureCode, AdmittedExternalFailureDefinitionCode>,
  Exclude<RequiredExternalFailureCode, AdmittedExternalFailureMappingCode>,
] extends [never, never] ? true : never = true;

if (!externalFailureContractsAreComplete) {
  throw new TypeError("Official asset public failure contracts are incomplete.");
}
