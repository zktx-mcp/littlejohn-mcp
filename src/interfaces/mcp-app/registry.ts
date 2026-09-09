import { exchangeApplicationContracts } from "../../review/application-contracts.js";
import { exchangeReviewSchema } from "../../review/contracts.js";
import type { PresentationSource } from "./contracts.js";
import { receiptApplicationContracts } from "../../receipt-activity/application-contracts.js";
import {
  captureCanonicalJson,
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
import { stockTokenTradeHistoryCapability } from "../../stock-token-trade-history/contracts.js";
import {
  tokenCatalogApplicationContracts,
  tokenInspectCapability,
} from "../../token-catalog/client.js";
import { walletManagementContracts } from "../../wallet/management-contracts.js";

declare const presentationContractEntryType: unique symbol;

export const presentationKindList = Object.freeze([
  "immutable_result",
  "transaction_review",
  "review",
  "operation",
] as const);
export type PresentationKind = typeof presentationKindList[number];

export interface PresentationContractEntry<Result = unknown> {
  readonly [presentationContractEntryType]?: Result;
  readonly contract: object;
  readonly contractId: string;
  readonly contractVersion: "1";
  readonly presentationKind: PresentationKind;
  readonly retention: "sqlite" | "review_memory";
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
  const review = exchangeReviewSchema.parse(result);
  if (review.state === "ready_for_wallet_review") {
    if (source.kind !== "review_memory" || source.operationId !== review.observation.data.operationId ||
        source.expiresAt !== review.observation.data.actionExpiresAt) throw new TypeError("Live decision source or lifetime differs from its Review.");
  } else if (source.kind !== "response_memory") throw new TypeError("A blocked decision has no replay source.");
};

interface ApplicationPresentationContract<Input, Result> {
  readonly capabilityId: string;
  readonly contractVersion: "1";
  readonly applicationContract: Readonly<{
    parseNormalizedInput(value: unknown): Input;
  }>;
  parseInput(value: unknown): Input;
  parsePublicSuccess(input: unknown, value: unknown): Result;
}

const capabilityEntry = <Input, Data>(
  definition: ReadCapabilityDefinition<Input, Data>,
  title: string,
): PresentationContractEntry<CapabilitySuccess<Data>> => {
  const identity = getCapabilityDefinitionSnapshot(definition);
  return Object.freeze({
    contract: definition,
    contractId: identity.capabilityId,
    contractVersion: identity.contractVersion,
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
): PresentationContractEntry<Result> => {
  return Object.freeze({
    contract,
    contractId: contract.capabilityId,
    contractVersion: contract.contractVersion,
    presentationKind,
    retention: presentationKind === "transaction_review" ? "review_memory" : "sqlite",
    title,
    parseInput: (value: unknown) => captureCanonicalJson(contract.parseInput(value)),
    parseNormalizedInput: (value: unknown) =>
      captureCanonicalJson(contract.applicationContract.parseNormalizedInput(value)),
    parseResult: (input: unknown, value: unknown) =>
      captureCanonicalJson(contract.parsePublicSuccess(input, value)),
  });
};

export const presentationContracts = Object.freeze({
  transactionReview: applicationEntry(exchangeApplicationContracts.start, "transaction_review", "USDG / Stock Token exchange"),
  activityTransaction: applicationEntry(receiptApplicationContracts.get, "immutable_result", "Transaction result"),
  activityTransactions: applicationEntry(receiptApplicationContracts.list, "immutable_result", "Recorded transactions"),
  accountAssets: applicationEntry(
    accountAssetApplicationContracts.collection,
    "immutable_result",
    "Account assets",
  ),
  addressInspection: capabilityEntry(addressInspectCapability, "Address inspection"),
  stockTokenTradeHistory: capabilityEntry(
    stockTokenTradeHistoryCapability,
    "Stock Token trade history",
  ),
  tokenAnalysis: capabilityEntry(tokenInspectCapability, "Token analysis"),
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
  ),
  tokenSelections: applicationEntry(
    tokenCatalogApplicationContracts.selections,
    "immutable_result",
    "Token selections",
  ),
  walletConnection: capabilityEntry(walletConnectionCapability, "Wallet connection"),
  walletOperation: applicationEntry(
    walletManagementContracts.operation,
    "operation",
    "Wallet operation",
  ),
  walletReview: applicationEntry(
    walletManagementContracts.review,
    "review",
    "Wallet connection change",
  ),
});

const entries: readonly PresentationContractEntry[] = Object.freeze(
  Object.values(presentationContracts),
);

export class PresentationContractRegistry {
  readonly #entries: readonly PresentationContractEntry[];
  readonly #byContract: ReadonlyMap<object, PresentationContractEntry>;
  readonly #byIdentity: ReadonlyMap<string, PresentationContractEntry>;

  constructor(entriesInput: readonly PresentationContractEntry[]) {
    const byContract = new Map<object, PresentationContractEntry>();
    const byIdentity = new Map<string, PresentationContractEntry>();
    for (const entry of entriesInput) {
      if (!presentationKindList.includes(entry.presentationKind) ||
          entry.retention !== (entry.presentationKind === "transaction_review" ? "review_memory" : "sqlite")) {
        throw new TypeError("Presentation kind is invalid.");
      }
      const identity = `${entry.contractId}\0${entry.contractVersion}`;
      if (byContract.has(entry.contract) || byIdentity.has(identity)) {
        throw new TypeError("Presentation contract identity is duplicated.");
      }
      byContract.set(entry.contract, entry);
      byIdentity.set(identity, entry);
    }
    this.#entries = Object.freeze([...entriesInput]);
    this.#byContract = byContract;
    this.#byIdentity = byIdentity;
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

  values(): readonly PresentationContractEntry[] { return this.#entries; }
}

export const presentationContractRegistry = new PresentationContractRegistry(entries);
