import type { ApplicationFailure } from "../core/client.js";
import {canonicalJsonStringify, captureCanonicalJson} from "../core/client.js";
import { productChainId, productDisplayName } from "../registry/client.js";
import type { DeliveryUnknown } from "./operation-delivery.js";

// Human projections only. Canonical states, errors and authority remain with
// their domain owners; consumers never parse these strings to make decisions.
export const presentationCopy = Object.freeze({
  title: {
    wallet: "Wallet connection", accountSelection: "Account selection", tokenVisibility: "Token visibility",
    accountBalances: "Account balances", tokenInformation: "Token information", addressInformation: "Address information",
    stockTokens: "Official Stock Tokens", prices: "Stock Token prices", history: "Stock Token trade history",
    transaction: "Transaction request", approval: "Token approval", replacement: "Replace transaction",
    signature: "Signature request", transactionResult: "Transaction result", transactions: "Recorded transactions",
  },
  label: {
    account: "Account", currentAccount: "Current account", accountToUse: "Account to use", network: "Network",
    wallet: "Wallet", token: "Token", tokenAddress: "Token address", name: "Name", symbol: "Symbol",
    balance: "Balance", totalSupply: "Total supply", amount: "Amount", rawAmount: "Raw amount",
    tokenBalance: "Token balance", adjustedBalance: "Adjusted balance", currentAdjustmentFactor: "Current adjustment factor",
    status: "Status", unavailable: "Unavailable", unknown: "Unknown", notApplicable: "Not applicable",
    asOf: "As of", availableUntil: "Available until", completedAt: "Completed at", publishedThrough: "Published through",
    source: "Source", freshness: "Data freshness", coverage: "Data coverage", requestedPeriod: "Requested period", availablePeriod: "Available period",
    assetDetails: "Asset details", connectionDetails: "Connection details", transactionDetails: "Transaction details",
    contractDetails: "Contract details", priceDetails: "Price details", yourRequest: "Your request", chartData: "Chart data",
    dataSource: "Data source", errorDetails: "Error details", exchangeAmounts: "Exchange amounts", accountAndFees: "Account and fees",
    approvalDetails: "Approval details", warnings: "Warnings", dataLimits: "Data limits",
    networkFee: "Network fee", maximumNetworkFee: "Maximum network fee", estimatedNetworkFee: "Estimated network fee", poolFee: "Pool fee",
    recipient: "Recipient", spender: "Spender", gasLimit: "Gas limit", maximumFeePerGas: "Maximum fee per gas",
    priorityFeeLimit: "Priority fee limit", nonce: "Nonce", transactionHash: "Transaction hash", replacesTransaction: "Replaces transaction",
    dataToSign: "Data to sign", messageBytes: "Message bytes", signingMethod: "Signing method", networkBinding: "Network binding", signature: "Signature",
    requestCheck: "Request check", effectCheck: "Effect check", networkConfirmation: "Network confirmation",
    sent: "Sent", received: "Received", approvedAmount: "Approved amount", approvalExpires: "Approval expires",
    intervalStart: "Interval start", intervalEnd: "Interval end", displayedFrom: "Displayed from", displayedUntil: "Displayed until",
    firstPrice: "First price", highestPrice: "Highest price", lowestPrice: "Lowest price", lastPrice: "Last price",
    usdgVolume: "USDG volume", tokenVolume: "Token volume", tradeCount: "Trade count", observedFrom: "Observed from", observedUntil: "Observed until",
    officialListing: "Official listing", requestedPermissions: "Requested permissions", approvedPermissions: "Approved permissions",
    required: "Required", optional: "Optional", otherPermissions: "Other permissions", price: "Price", priceUnit: "Price unit", exactPrice: "Exact price",
    block: "Block", contractAddress: "Contract address", owner: "Owner", administrator: "Administrator", pauseStatus: "Pause status",
    proxy: "Proxy", implementation: "Implementation", declaredFunctions: "Declared functions",
    errorCode: "Error code", reportedReason: "Reported reason", field: "Field", amountUnavailable: "Amount unavailable", noAccount: "No account selected",
  },
  action: {
    connect: "Connect wallet", disconnect: "Disconnect wallet", selectAccount: "Use this account", chooseAccount: "Choose an account",
    showToken: "Show token", hideToken: "Hide token", requestTransaction: "Request wallet approval", requestSignature: "Request signature",
    closeRequest: "Close request", cancelConnection: "Cancel connection", stopWaiting: "Stop waiting", closeSignature: "Close signature",
    retryOpening: "Retry opening", reloadCard: "Reload saved card",
  },
  scope: {
    accountSelection: `This selects the account for new requests in ${productDisplayName}. It does not switch your wallet's network or change its permissions. Existing requests keep their original account.`,
    tokenVisibility: "This only changes the tokens shown for this account. It does not transfer or delete tokens.",
    connect: "Connecting shares the listed accounts and permissions. It does not approve a transaction or signature request.",
    disconnect: "This disconnects the listed connections, including their approved accounts and networks. It does not transfer assets.",
    walletApproval: "Your wallet must approve this request separately. Approval does not guarantee that the transaction will be included.",
    revertFee: "A failed transaction can still cost a network fee.",
    approvalNoExpiry: "This approval has no automatic expiry. Closing this request does not revoke it.",
    replacement: "This request replaces the listed pending transaction using the same nonce. Replacement and inclusion are not guaranteed.",
    noNetworkBinding: "This signed data is not bound to a network.",
    signing: "Signing this data does not send a transaction or prove an action in another service. Closing the result does not revoke the signature.",
    manualCopy: "Select the complete signature and use your device's copy command.",
    history: `This is ${productDisplayName}'s saved history, not all transactions for this account.`,
    selectedTokens: "Only tokens selected for display are listed.", moreItems: "More items are available beyond this result.",
    tokenBalances: "Token balances are before display adjustment.",
    adjustedBalances: "Adjusted balances include the tokens' current display adjustments. These adjustments do not change transaction amounts.",
    adjustmentUnknown: "The token's display adjustment could not be confirmed.",
    adjustmentInconsistent: "The token's display-adjustment data could not be verified.",
    adjustmentOutOfRange: "The adjusted balance is outside the supported amount range.",
    nonzeroUnitUnavailable: "Token unit information is unavailable for nonzero amounts.",
    prices: "These are pool prices in USDG, not trade quotes or USD prices.",
    pools: "Only pools reported by this source are shown. This is not a complete pool list or a best-price selection.",
    dynamicFee: "This pool may use a different fee when a trade is executed. The fee shown is not a final quote.",
    officialListing: "Official listing does not confirm a pool, a current price, or token safety.",
    officialClassification: "Official listing does not prove token safety or ownership of underlying shares.",
    amountUnavailable: "The amount cannot be shown in token units because its unit information is unavailable.",
    classificationUnavailable: "The token's official classification could not be confirmed.",
    snapshot: "This card shows recorded data. It does not refresh automatically.",
    safeBlock: "Safe block is a network status, not a token safety rating.",
    reloadCard: "This reloads this card's saved information. It does not repeat the action.",
    pendingQuery: "Ask in chat to check the current result for this transaction.",
    walletPrompt: "If your wallet asks for approval, review the request there.",
    scan: "Scan this code with your wallet to connect.",
    multipleConnections: "More than one wallet connection was found.",
    empty: "No items were found in this result.",
  },
  coverage: { complete: "Complete", partial: "Partial", unavailable: "Unavailable" },
  freshness: { current: "Current", stale: "Stale", unknown: "Unknown" },
  comparison: { matched: "Matches", mismatched: "Does not match", unavailable: "Unavailable", not_executed: "Not executed" },
  finality: { included: "Included", safe: "Safe block", finalized: "Finalized", unavailable: "Unavailable" },
  standard: { observed: "Observed", supported: "Supported", not_supported: "Unsupported", unknown: "Unknown", inconsistent: "Inconsistent", not_declared: "Not declared", not_enumerable: "Cannot list", limit_exceeded: "Too many results" },
  method: { personal_sign: "Message signature", eth_signTypedData_v4: "Typed data signature" },
  permission: { eth_sendTransaction: "Transaction approval requests", personal_sign: "Message signature requests", eth_signTypedData_v4: "Typed data signature requests" },
  classification: { robinhood_stock_token: "Robinhood Stock Token", custom_erc20: "Custom token", unavailable: "Unavailable" },
  chart: {
    unit: "Trades in USDG",
    before: "Data starts after the requested period begins.", after: "Data ends before the requested period ends.",
    partialCandle: "This partial candle includes the full stored interval and may include trades outside the requested period.",
    emptyComplete: "No qualifying trades occurred in this complete interval.",
    emptyPartial: "Data is incomplete for this interval. No-trade status is not confirmed.",
    emptyUnavailable: "Published data is unavailable for this interval. No-trade status is not confirmed.",
    allEmpty: "No qualifying trades occurred in the requested period.", allEmptyUnknown: "No-trade status is not confirmed for the entire requested period.",
    intervals: "Intervals include the start time and stop before the end time.",
  },
} as const);
export const visibilityText = (included: boolean): string => included ? "Shown" : "Hidden";
export const networkText = (chainId: string): string => chainId === productChainId ? "Robinhood Chain" : `Unsupported network (${chainId})`;
export const permissionText = (method: string): string => Object.hasOwn(presentationCopy.permission, method)
  ? presentationCopy.permission[method as keyof typeof presentationCopy.permission] : method;
export const tokenTextIssue = (field: "name" | "symbol", reason: "call_failed" | "malformed" | "unsafe_text"): string => ({
  call_failed: `The token ${field} could not be read.`, malformed: `The token returned an invalid ${field}.`,
  unsafe_text: `The token ${field} contains unsupported text and is not shown.`,
})[reason];
export const freshnessText = (freshness: "current" | "stale" | "unknown", time: string): string => freshness === "unknown"
  ? "The freshness of this data could not be confirmed."
  : `This data was ${freshness === "current" ? "up to date" : "out of date"} when checked at ${time}.`;
export const coverageText = (coverage: "complete" | "partial" | "unavailable", period = false): string => coverage === "complete"
  ? period ? "Data covers the requested period." : "Data covers the declared scope."
  : "Some of the requested data is unavailable.";

export type PresentationRole = "pending" | "completed" | "cancelled" | "rejected" | "expired" | "failed" | "unavailable" | "error";
export interface StatusCopy { readonly label: string; readonly message: string; readonly role: PresentationRole }
const state = (label: string, message: string, role: PresentationRole = "pending"): StatusCopy => ({ label, message, role });
export const statusCopy = Object.freeze({
  loading: state("Loading…", `${productDisplayName} is loading this result.`),
  decision: state("Your decision is needed", "Check the details before continuing."),
  notSubmitted: state("Not submitted", "This request has not been submitted. Use the original request card to continue.", "unavailable"),
  inputUnavailable: state("Not submitted", "This request has not been submitted. Input is unavailable in this card.", "unavailable"),
  submitting: state("Submitting…", `${productDisplayName} is submitting this request.`),
  checkingResult: state("Checking result…", "Your request was accepted. Its result has not been confirmed yet."),
  starting_connection: state("Connecting…", `${productDisplayName} is starting the wallet connection request.`),
  awaiting_wallet_approval: state("Waiting for wallet approval", "Open your wallet to approve or decline this request."),
  validating_session: state("Checking connection…", `${productDisplayName} is checking the accounts and permissions shared by your wallet.`),
  cancelling: state("Cancelling connection…", `${productDisplayName} is cancelling this connection request.`),
  disconnecting: state("Disconnecting…", `${productDisplayName} is disconnecting the listed wallet connections.`),
  connected: state("Completed", "A wallet connection was established for this request.", "completed"),
  disconnected: state("Completed", `The listed wallet connections were disconnected from ${productDisplayName}.`, "completed"),
  shown: state("Completed", "This request set the token to Shown for this account.", "completed"),
  hidden: state("Completed", "This request set the token to Hidden for this account.", "completed"),
  accountSelected: state("Completed", "This account was selected for new requests.", "completed"),
  cancelled: state("Cancelled", `This connection request was cancelled in ${productDisplayName}. Your wallet may still show the request.`, "cancelled"),
  rejected: state("Declined", "Your wallet declined this request.", "rejected"),
  expired: state("Expired", "This request has expired and cannot be submitted from this card.", "expired"),
  connectionExpired: state("Expired", "The connection request expired before approval was confirmed. Your wallet may still show the request.", "expired"),
  discarded: state("Closed", `This request was closed in ${productDisplayName}. It cannot be submitted from this card.`, "cancelled"),
  invalidated: state("Unavailable", "The information for this request is no longer valid. It cannot be submitted from this card.", "unavailable"),
  owner_lost: state("Unavailable", `This request is no longer available in ${productDisplayName}.`, "unavailable"),
  failed: state("Request failed", "This request could not be completed.", "failed"),
  actionUnknown: state("Result unknown", "The result of this action could not be confirmed. It will not be repeated automatically.", "unavailable"),
  delivery_unknown: state("Result unknown", `${productDisplayName} stopped waiting without a confirmed wallet result. The request may still complete or may already have completed. It will not be repeated automatically.`, "unavailable"),
  not_sent: state("Not sent", "This request was not sent to your wallet.", "unavailable"),
  hash_returned: state("Not confirmed", "A transaction hash was received. Execution has not been confirmed.", "unavailable"),
  pending: state("Pending", "The transaction is pending according to the recorded network response."),
  success: state("Succeeded", "The transaction succeeded in the recorded block.", "completed"),
  reverted: state("Transaction failed", "The transaction failed. A network fee was still charged.", "failed"),
  reorged: state("Not confirmed", "The previously recorded block is no longer canonical. This result is not confirmed.", "unavailable"),
  not_found: state("Not found", "No result was found in this observation. This does not prove that no transaction was sent.", "unavailable"),
  verified: state("Verified", "The signature matches the data and account in your request.", "completed"),
  verification_failed: state("Verification failed", "The signature did not match the data and account in your request. No usable signature is shown.", "failed"),
  unsupported_signature: state("Unsupported signature", `${productDisplayName} could not verify this signature format. No usable signature is shown.`, "unavailable"),
  signatureUnavailable: state("Signature unavailable", "The verified signature could not be displayed here. No new signature request will be sent automatically.", "unavailable"),
  signatureClosed: state("Closed", "The signature is no longer shown here. Closing it does not revoke the signature or remove copies you made.", "cancelled"),
  ended: state("Request ended", "This request ended, but its result details could not be confirmed.", "unavailable"),
  saved: state("Saved result", "This card shows the saved result."),
  detailsUnavailable: state("Details unavailable", "Some details could not be displayed. The confirmed information is still shown.", "unavailable"),
  presentationUnavailable: state("Couldn't load this result", `${productDisplayName} could not verify the data needed to show this result.`, "error"),
  savedReadFailed: state("Couldn't load this result", "The saved information for this card could not be read.", "error"),
  directReadUnavailable: state("Unavailable", "This app cannot open the saved result. No action was requested.", "unavailable"),
});
export const savedSignatureText = "The signature value is not available from this saved result.";
export const localDecisionNotSubmittedText = "Not submitted. This command did not apply the change.";
export const deliveryUnknownText = (delivery: DeliveryUnknown): string => [
  statusCopy.actionUnknown.label,
  statusCopy.actionUnknown.message,
  ...(delivery.action === "select_account" ? [] : [`Operation ID: ${delivery.operationId}`]),
  "The action may have occurred. Do not repeat it.",
  delivery.action === "select_account"
    ? "Read wallet account-selection. The effective account alone does not prove this call succeeded."
    : "Inspect that exact operation before another state change.",
].join("\n");
export const connectionCopy = Object.freeze({
  connected: state("Connected", "A wallet connection was available for this network when checked.", "completed"),
  disconnected: state("Disconnected", "No wallet connection was available for this network when checked.", "unavailable"),
  expired: state("Disconnected", "The wallet connection had expired when checked.", "expired"),
  reconciling: state("Checking connection…", `${productDisplayName} is checking the saved wallet connection.`),
  observation_unavailable: state("Unknown", "The wallet connection could not be checked.", "unavailable"),
  unresolved: state("Needs attention", "A usable wallet connection could not be confirmed.", "unavailable"),
});
export const readReasonCopy = Object.freeze({
  official_asset_not_found: "No matching official Stock Token was found.",
  official_asset_symbol_ambiguous: "This symbol matches more than one official Stock Token. Use the token address to identify it.",
  stock_factory_unavailable: "The official token's on-chain identity could not be verified.",
  token_decimals_unavailable: "Token unit information is unavailable.",
  asset_not_supported: "The published trade history does not include this token.", trade_history_unavailable: "Trade history is unavailable.",
  trade_history_inconsistent: "The trade history data could not be verified.", trade_history_too_large: `This trade history is larger than ${productDisplayName} can handle.`,
  outside_published_coverage: "The requested period is outside the published trade history.",
  pool_identity_mismatch: "The pool or contract identity does not match the requested market.", deployment_identity_mismatch: "The pool or contract identity does not match the requested market.",
  pool_metadata_unavailable: "The data needed to show this pool price is unavailable.", pool_state_unavailable: "The data needed to show this pool price is unavailable.",
  chain_response_unavailable: "The data needed to show this pool price is unavailable.", source_unavailable: "The data needed to show this pool price is unavailable.",
  pool_uninitialized: "This pool has no usable price yet.", pool_response_malformed: "The pool data could not be verified.", source_inconsistent: "The pool data could not be verified.",
  rate_limited: "The data source is limiting requests.", unsupportedPool: "This pool's protocol or version is not supported.",
});
const failureMessages: Readonly<Record<string, string>> = Object.freeze({
  invalid_input: "Some request details are invalid. Check the fields listed in Error details.",
  wallet_not_connected: "No connected wallet is available for this request.", wallet_account_selection_required: "Choose an account before continuing.",
  wallet_account_unavailable: "No approved account can be used for this request.", wallet_session_unusable: "This wallet connection cannot provide the accounts or permissions required by this request.",
  wallet_pairing_code_unavailable: "The wallet connection code could not be created.", walletconnect_unavailable: "The wallet request could not be completed.",
  wallet_timeout: `${productDisplayName} stopped waiting for your wallet. The wallet's result has not been confirmed.`, wallet_user_rejected: statusCopy.rejected.message,
  interactive_terminal_required: "This action requires an interactive terminal.",
  wallet_operation_expired: statusCopy.expired.message, token_review_expired: statusCopy.expired.message, review_expired: statusCopy.expired.message,
  review_unavailable: "The details needed for this request are no longer available.",
  wallet_operation_not_found: "This saved result could not be found.", token_operation_not_found: "This saved result could not be found.", exchange_operation_not_found: "This saved result could not be found.", presentation_not_found: "This saved result could not be found.",
  token_selection_already_included: "The token is already shown for this account.", token_selection_not_included: "The token is hidden for this account.", token_selection_not_found: "This token has no saved display setting for this account.",
  token_selection_revision_changed: "The information used for this request has changed.", state_conflict: "The information used for this request has changed.",
  token_total_supply_reverted: "The token's total supply could not be read.", runtime_state_unavailable: `${productDisplayName} could not get the local information needed for this request.`, runtime_busy: `${productDisplayName} is busy with another request.`,
  port_conflict: `${productDisplayName} could not verify the local service at its connection address.`, request_aborted: "The request ended before a result was confirmed.",
  source_unavailable: "The required data could not be obtained.", chain_response_unavailable: "The required data could not be obtained.", official_asset_response_unavailable: "The required data could not be obtained.",
  source_inconsistent: "The returned data could not be verified.", presentation_inconsistent: "The returned data could not be verified.", rate_limited: "The data source is limiting requests.", not_found: "The requested data was not found.",
  factory_identity_mismatch: "The token or contract identity could not be verified.", token_identity_mismatch: "The token or contract identity could not be verified.", token_code_missing: "The token or contract identity could not be verified.",
  ...Object.fromEntries(["result_too_large", "payload_too_large", "presentation_capacity_exceeded", "review_capacity_exceeded", "exchange_capacity_exceeded", "pool_candidate_response_too_large", "official_asset_response_too_large"].map(code => [code, `This request or result is larger than ${productDisplayName} can handle.`])),
  exchange_conditions_unmet: "The current exchange does not meet your requested conditions.", exchange_replacement_unavailable: "An eligible pending transaction could not be confirmed for replacement.", exchange_contract_unavailable: "A required exchange contract could not be verified.", exchange_pool_unsupported: "This pool is not supported for this exchange.",
});
const categoryMessages = {
  input: "Some request details could not be accepted.", security: "This request could not be authorized.",
  source: "The required data or response could not be obtained.", transport: "The required data or response could not be obtained.",
  runtime: "The local information needed for this request is unavailable or has changed.", state: "The local information needed for this request is unavailable or has changed.",
  wallet: "The wallet request could not be completed.", domain: "This request could not be completed.", internal: "This request could not be completed.",
} satisfies Record<ApplicationFailure["error"]["category"], string>;
export const failureCopy = (error: Pick<ApplicationFailure["error"], "code" | "category">): StatusCopy => {
  const label = error.code === "wallet_user_rejected" ? statusCopy.rejected
    : ["wallet_operation_expired", "token_review_expired", "review_expired"].includes(error.code) ? statusCopy.expired
    : ["not_found", "wallet_operation_not_found", "token_operation_not_found", "exchange_operation_not_found", "presentation_not_found"].includes(error.code) ? statusCopy.not_found : statusCopy.failed;
  return { ...label, message: failureMessages[error.code] ?? categoryMessages[error.category] };
};
export const approvalText = (spender: string, amount: string, unit: string): string =>
  `This approval allows ${spender} to use up to ${amount}${unit.length === 0 ? "" : ` ${unit}`}. It does not perform the exchange.`;
export const approvalExpiryText = (time: string): string => `This approval expires at ${time}.`;
export const networkBindingText = (network: string): string => `This signed data is bound to ${network}.`;
export const amountRelationText = (direction: "send" | "receive", relation: "equal" | "at_most" | "at_least"): string => ({
  send: { equal: "Send exactly", at_most: "Send up to", at_least: "Send at least" },
  receive: { equal: "Receive exactly", at_most: "Receive up to", at_least: "Receive at least" },
})[direction][relation];
export const addressCodeCopy = Object.freeze({
  runtime_code_observed: {label: "Contract code found", message: "Contract code was observed at this address in the recorded block. This does not establish safety or ownership."},
  no_runtime_code_observed: {label: "No contract code found", message: "No contract code was observed at this address in the recorded block. This does not prove the address type or ownership."},
});
export const walletOperationCopy = (state: import("../wallet/contracts.js").WalletManagementOperation["state"], action: "connect" | "disconnect"): StatusCopy =>
  state === "completed" ? action === "connect" ? statusCopy.connected : statusCopy.disconnected
    : state === "expired" ? statusCopy.connectionExpired : statusCopy[state];
export const connectionStatusCopy = (value: import("../wallet/connection-contract.js").WalletConnectionData): StatusCopy =>
  value.status === "unknown" ? connectionCopy[value.reason]
    : value.status === "disconnected" && value.reason === "expired" ? connectionCopy.expired : connectionCopy[value.status];
// Preserve exact data while making controls, separators and direction changes
// inspectable instead of allowing them to control terminal or visual output.
export const exactDataText = (value: unknown): string => canonicalJsonStringify(captureCanonicalJson(value))
  .replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
export const failureDetailsFields = (
  error: Pick<ApplicationFailure["error"], "code" | "message"> & Partial<Pick<ApplicationFailure["error"], "issues">>,
): readonly (readonly [string, string])[] => [
  [presentationCopy.label.errorCode, error.code],
  [presentationCopy.label.reportedReason, error.message],
  ...(error.issues ?? []).flatMap(issue => [
    [presentationCopy.label.field, exactDataText(issue.path)] as const,
    [presentationCopy.label.errorCode, issue.code] as const,
    [presentationCopy.label.reportedReason, issue.message] as const,
  ]),
];
export const failureText = (failure: ApplicationFailure): string => {
  const value = failureCopy(failure.error);
  const message = ["wallet_operation_expired", "token_review_expired", "review_expired"].includes(failure.error.code)
    ? "This request has expired and cannot be submitted." : value.message;
  return [value.label, message, presentationCopy.label.errorDetails,
    ...failureDetailsFields(failure.error).map(([label, text]) => `${label}: ${text}`)].join("\n");
};
