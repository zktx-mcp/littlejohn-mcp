import type {
  chainErrorDefinitions,
  chainInterfaceErrorMappingDefinitions,
} from "../chain/error-definitions.js";
import type {
  OfficialAssetSourceUnavailableReason,
  StockFactoryClassificationUnavailableReason,
} from "../registry/browser.js";
import type {
  runtimeErrorDefinitions,
  runtimeInterfaceErrorMappingDefinitions,
} from "../runtime/error-definitions.js";

export const tokenCatalogErrorDefinitions = Object.freeze([
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
  {
    code: "token_selection_already_included",
    category: "state",
    message: "The token is already included for the current account.",
    retryable: false,
  },
  {
    code: "token_selection_not_found",
    category: "state",
    message: "The token has no account selection.",
    retryable: false,
  },
  {
    code: "token_selection_not_included",
    category: "state",
    message: "The token is not included for the current account.",
    retryable: false,
  },
  {
    code: "token_selection_revision_changed",
    category: "state",
    message: "The token selection changed before the request completed.",
    retryable: false,
  },
  {
    code: "token_total_supply_reverted",
    category: "domain",
    message: "The token contract reverted the required totalSupply call.",
    retryable: false,
  },
  {
    code: "token_operation_conflict",
    category: "state",
    message: "Another account token operation is active.",
    retryable: false,
  },
  {
    code: "token_operation_not_found",
    category: "state",
    message: "The account token operation is not available.",
    retryable: false,
  },
  {
    code: "token_operation_expired",
    category: "state",
    message: "The account token operation expired before confirmation.",
    retryable: false,
  },
] as const);

export const tokenCatalogInterfaceErrorMappingDefinitions = Object.freeze([
  { code: "official_asset_response_unavailable", httpStatus: 502, problemTitle: "Official asset response unavailable", cliExitCode: 4 },
  { code: "official_asset_response_too_large", httpStatus: 502, problemTitle: "Official asset response too large", cliExitCode: 4 },
  { code: "factory_identity_mismatch", httpStatus: 502, problemTitle: "StockFactory identity mismatch", cliExitCode: 4 },
  { code: "token_code_missing", httpStatus: 502, problemTitle: "Token code missing", cliExitCode: 4 },
  { code: "token_identity_mismatch", httpStatus: 502, problemTitle: "Token identity mismatch", cliExitCode: 4 },
  { code: "token_selection_already_included", httpStatus: 409, problemTitle: "Token already included", cliExitCode: 5 },
  { code: "token_selection_not_found", httpStatus: 404, problemTitle: "Token selection not found", cliExitCode: 3 },
  { code: "token_selection_not_included", httpStatus: 409, problemTitle: "Token not included", cliExitCode: 5 },
  { code: "token_selection_revision_changed", httpStatus: 409, problemTitle: "Token selection changed", cliExitCode: 5 },
  { code: "token_total_supply_reverted", httpStatus: 422, problemTitle: "Token total supply reverted", cliExitCode: 3 },
  { code: "token_operation_conflict", httpStatus: 409, problemTitle: "Token operation conflict", cliExitCode: 5 },
  { code: "token_operation_not_found", httpStatus: 404, problemTitle: "Token operation not found", cliExitCode: 3 },
  { code: "token_operation_expired", httpStatus: 409, problemTitle: "Token operation expired", cliExitCode: 5 },
] as const);

type RequiredExternalFailureCode =
  | OfficialAssetSourceUnavailableReason
  | StockFactoryClassificationUnavailableReason;
type AdmittedExternalFailureDefinitionCode =
  | (typeof runtimeErrorDefinitions)[number]["code"]
  | (typeof chainErrorDefinitions)[number]["code"]
  | (typeof tokenCatalogErrorDefinitions)[number]["code"];
type AdmittedExternalFailureMappingCode =
  | (typeof runtimeInterfaceErrorMappingDefinitions)[number]["code"]
  | (typeof chainInterfaceErrorMappingDefinitions)[number]["code"]
  | (typeof tokenCatalogInterfaceErrorMappingDefinitions)[number]["code"];

const externalFailureContractsAreComplete: [
  Exclude<RequiredExternalFailureCode, AdmittedExternalFailureDefinitionCode>,
  Exclude<RequiredExternalFailureCode, AdmittedExternalFailureMappingCode>,
] extends [never, never] ? true : never = true;

if (!externalFailureContractsAreComplete) {
  throw new TypeError("Official asset public failure contracts are incomplete.");
}
