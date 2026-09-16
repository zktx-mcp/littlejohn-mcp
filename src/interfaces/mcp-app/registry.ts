import { chainErrorRegistry } from "../../chain/error-registry.js";
import { walletErrorRegistry } from "../../wallet/error-registry.js";
import { exchangeApplicationContracts } from "../../review/application-contracts.js";
import { requestReviewPresentationIdentity } from "../../review/presentation-contract.js";
import { signingApplicationContracts } from "../../review/signing-application-contracts.js";
import type { PresentationSource } from "./contracts.js";
import { receiptApplicationContracts } from "../../receipt-activity/application-contracts.js";
import {
  captureCanonicalJson, canonicalJsonStringify, applicationFailureSchemaFor,
  type ApplicationFailure, type ApplicationErrorRegistry,
  addressInspectCapability,
  getCapabilityDefinitionSnapshot,
  parseCapabilityInput,
  parseCapabilitySuccess,
  walletConnectionCapability,
  type CanonicalJson,
  type CapabilitySuccess,
  type ReadCapabilityDefinition,
} from "../../core/client.js";
import { accountAssetApplicationContracts } from "../../account-assets/client.js";
import { stockTokenTradeHistoryCapability, stockTokenTradeHistoryErrorRegistry } from "../../stock-token-trade-history/contracts.js";
import { stockTokenPricesCapability, stockTokensCapability, stockTokenPricesErrorRegistry } from "../../stock-token-prices/contracts.js";
import {
  tokenCatalogApplicationContracts, tokenCatalogErrorRegistry,
  tokenInspectCapability,
} from "../../token-catalog/client.js";
import { walletManagementContracts } from "../../wallet/management-contracts.js";

declare const presentationContractEntryType: unique symbol;

export const presentationKindList = Object.freeze([
  "immutable_result",
  "transaction_review",
  "signing_review",
  "review",
  "operation",
] as const);
export type PresentationKind = typeof presentationKindList[number];
export const presentationDecisionKinds = Object.freeze(["wallet", "token_selection", "transaction", "signing"] as const);
export type PresentationDecisionKind = typeof presentationDecisionKinds[number];

export interface PresentationContractEntry<Result = unknown> {
  readonly [presentationContractEntryType]?: Result;
  readonly contract: object;
  readonly contractId: string;
  readonly contractVersion: "1";
  readonly errorRegistry: ApplicationErrorRegistry;
  readonly failureCodes: readonly string[];
  parseFailure(value: unknown): ApplicationFailure;
  readonly presentationKind: PresentationKind;
  readonly retention: "sqlite" | "review_memory";
  readonly cardKind?: PresentationDecisionKind;
  readonly title: string;
  parseInput(value: unknown): CanonicalJson;
  parseNormalizedInput(value: unknown): CanonicalJson;
  parseResult(input: unknown, value: unknown): CanonicalJson;
}

export type PresentationContractResult<Entry> =
  Entry extends PresentationContractEntry<infer Result> ? Result : never;

export const assertPresentationSource = (entry: PresentationContractEntry, result: CanonicalJson, source: PresentationSource): void => {
  if (entry.retention === "sqlite") {
    if (source.kind !== "sqlite") throw new TypeError("Presentation source differs from its owning contract.");
    return;
  }
  const review = requestReviewPresentationIdentity(result);
  if (review !== null) {
    if (source.kind !== "review_memory" || source.operationId !== review.operationId ||
        source.expiresAt !== review.expiresAt) throw new TypeError("Live decision source or lifetime differs from its Review.");
  } else if (source.kind !== "response_memory") throw new TypeError("A blocked decision has no replay source.");
};

interface ApplicationPresentationContract<Input, Result> {
  readonly capabilityId: string;
  readonly contractVersion: "1";
  readonly applicationContract: Readonly<{
    readonly errorRegistry: ApplicationErrorRegistry;
    parseNormalizedInput(value: unknown): Input;
  }>;
  readonly failureCodes: readonly string[];
  parseFailure(value: unknown): ApplicationFailure;
  parseInput(value: unknown): Input;
  parsePublicSuccess(input: unknown, value: unknown): Result;
}

const capabilityEntry = <Input, Data>(
  definition: ReadCapabilityDefinition<Input, Data>,
  title: string,
  errorRegistry: ApplicationErrorRegistry,
): PresentationContractEntry<CapabilitySuccess<Data>> => {
  const identity = getCapabilityDefinitionSnapshot(definition);
  const failureSchema = applicationFailureSchemaFor(errorRegistry, identity.failureCodes);
  return Object.freeze({
    contract: definition,
    contractId: identity.capabilityId,
    contractVersion: identity.contractVersion,
    errorRegistry, failureCodes: identity.failureCodes, parseFailure: (value: unknown) => failureSchema.parse(value),
    presentationKind: "immutable_result",
    retention: "sqlite",
    title,
    parseInput: (value: unknown) => captureCanonicalJson(parseCapabilityInput(definition, value)),
    parseNormalizedInput: (value: unknown) =>
      captureCanonicalJson(parseCapabilityInput(definition, value)),
    parseResult: (input: unknown, value: unknown) =>
      captureCanonicalJson(parseCapabilitySuccess(definition, input, value)),
  });
};

const applicationEntry = <Input, Result>(
  contract: ApplicationPresentationContract<Input, Result>,
  presentationKind: PresentationKind,
  title: string,
  cardKind?: PresentationDecisionKind,
): PresentationContractEntry<Result> => {
  return Object.freeze({
    contract,
    contractId: contract.capabilityId,
    contractVersion: contract.contractVersion,
    errorRegistry: contract.applicationContract.errorRegistry, failureCodes: contract.failureCodes, parseFailure: (value: unknown) => contract.parseFailure(value),
    presentationKind,
    retention: presentationKind === "transaction_review" || presentationKind === "signing_review" ? "review_memory" : "sqlite",
    title,
    ...(cardKind === undefined ? {} : { cardKind }),
    parseInput: (value: unknown) => captureCanonicalJson(contract.parseInput(value)),
    parseNormalizedInput: (value: unknown) =>
      captureCanonicalJson(contract.applicationContract.parseNormalizedInput(value)),
    parseResult: (input: unknown, value: unknown) =>
      captureCanonicalJson(contract.parsePublicSuccess(input, value)),
  });
};

export const presentationContracts = Object.freeze({
  stockTokenPrices: capabilityEntry(stockTokenPricesCapability, "Stock Token pool prices", stockTokenPricesErrorRegistry),
  stockTokens: capabilityEntry(stockTokensCapability, "Official Stock Tokens", stockTokenPricesErrorRegistry),
  transactionReview: applicationEntry(exchangeApplicationContracts.start, "transaction_review", "USDG / Stock Token exchange", "transaction"),
  signingReview: applicationEntry(signingApplicationContracts.start, "signing_review", "Sign data", "signing"),
  activityTransaction: applicationEntry(receiptApplicationContracts.get, "immutable_result", "Transaction result"),
  activityTransactions: applicationEntry(receiptApplicationContracts.list, "immutable_result", "Recorded transactions"),
  accountAssets: applicationEntry(
    accountAssetApplicationContracts.collection,
    "immutable_result",
    "Account assets",
  ),
  addressInspection: capabilityEntry(addressInspectCapability, "Address inspection", chainErrorRegistry),
  stockTokenTradeHistory: capabilityEntry(
    stockTokenTradeHistoryCapability,
    "Stock Token trade history",
    stockTokenTradeHistoryErrorRegistry,
  ),
  tokenAnalysis: capabilityEntry(tokenInspectCapability, "Token analysis", tokenCatalogErrorRegistry),
  tokenSelection: applicationEntry(
    tokenCatalogApplicationContracts.selection,
    "immutable_result",
    "Token selection",
  ),
  tokenSelectionOperation: applicationEntry(
    tokenCatalogApplicationContracts.operation,
    "operation",
    "Token selection change",
  ),
  tokenSelectionReview: applicationEntry(
    tokenCatalogApplicationContracts.selectionChangeReview,
    "review",
    "Token selection change",
    "token_selection",
  ),
  tokenSelections: applicationEntry(
    tokenCatalogApplicationContracts.selections,
    "immutable_result",
    "Token selections",
  ),
  walletConnection: capabilityEntry(walletConnectionCapability, "Wallet connection", walletErrorRegistry),
  walletOperation: applicationEntry(
    walletManagementContracts.operation,
    "operation",
    "Wallet operation",
  ),
  walletReview: applicationEntry(
    walletManagementContracts.review,
    "review",
    "Wallet connection change",
    "wallet",
  ),
});

const entries: readonly PresentationContractEntry[] = Object.freeze(
  Object.values(presentationContracts),
);

export class PresentationContractRegistry {
  readonly #entries: readonly PresentationContractEntry[];
  readonly #failureParsers: ReadonlyMap<string, (value: unknown) => ApplicationFailure>;
  readonly #byContract: ReadonlyMap<object, PresentationContractEntry>;
  readonly #byIdentity: ReadonlyMap<string, PresentationContractEntry>;
  readonly #byCardKind: ReadonlyMap<PresentationDecisionKind, PresentationContractEntry>;

  constructor(entriesInput: readonly PresentationContractEntry[]) {
    const failureParsers = new Map<string, (value: unknown) => ApplicationFailure>();
    const failureDefinitions = new Map<string, string>();
    const byContract = new Map<object, PresentationContractEntry>();
    const byIdentity = new Map<string, PresentationContractEntry>();
    const byCardKind = new Map<PresentationDecisionKind, PresentationContractEntry>();
    for (const entry of entriesInput) {
      for (const code of entry.failureCodes) {
        const definition = canonicalJsonStringify(captureCanonicalJson(entry.errorRegistry.get(code)));
        const existing = failureDefinitions.get(code);
        if (existing !== undefined && existing !== definition) throw new TypeError("Presentation failure owners disagree.");
        failureDefinitions.set(code, definition);
        failureParsers.set(code, entry.parseFailure);
      }
      if (!presentationKindList.includes(entry.presentationKind) ||
          entry.retention !== (entry.presentationKind === "transaction_review" || entry.presentationKind === "signing_review" ? "review_memory" : "sqlite")) {
        throw new TypeError("Presentation kind is invalid.");
      }
      if (entry.cardKind !== undefined) {
        if (!presentationDecisionKinds.includes(entry.cardKind) || byCardKind.has(entry.cardKind) ||
            entry.presentationKind === "immutable_result" || entry.presentationKind === "operation") {
          throw new TypeError("Card source registration is invalid or duplicated.");
        }
        byCardKind.set(entry.cardKind, entry);
      }
      const identity = `${entry.contractId}\0${entry.contractVersion}`;
      if (byContract.has(entry.contract) || byIdentity.has(identity)) {
        throw new TypeError("Presentation contract identity is duplicated.");
      }
      byContract.set(entry.contract, entry);
      byIdentity.set(identity, entry);
    }
    this.#failureParsers = failureParsers;
    this.#entries = Object.freeze([...entriesInput]);
    this.#byContract = byContract;
    this.#byIdentity = byIdentity;
    this.#byCardKind = byCardKind;
    Object.freeze(this);
  }

  forContract(contract: object): PresentationContractEntry | undefined {
    return this.#byContract.get(contract);
  }

  requireIdentity(contractId: unknown, contractVersion: unknown): PresentationContractEntry {
    if (typeof contractId !== "string" || typeof contractVersion !== "string") {
      throw new TypeError("Presentation contract identity is invalid.");
    }
    const entry = this.#byIdentity.get(`${contractId}\0${contractVersion}`);
    if (entry === undefined) throw new TypeError("Presentation contract is not registered.");
    return entry;
  }

  requireCardKind(kind: PresentationDecisionKind): PresentationContractEntry {
    const entry = this.#byCardKind.get(kind);
    if (entry === undefined) throw new TypeError("Card source is not registered.");
    return entry;
  }

  parseFailure(value: unknown): ApplicationFailure | undefined {
    if (typeof value !== "object" || value === null || !("error" in value) ||
        typeof value.error !== "object" || value.error === null || !("code" in value.error) || typeof value.error.code !== "string") return undefined;
    const parse = this.#failureParsers.get(value.error.code);
    if (parse === undefined) return undefined;
    try { return parse(value); } catch { return undefined; }
  }

  values(): readonly PresentationContractEntry[] { return this.#entries; }
}

export const presentationContractRegistry = new PresentationContractRegistry(entries);
