import {
  canonicalJsonStringify,
  captureCanonicalJson,
  contractInspectCapability,
  getCapabilityDefinitionSnapshot,
  parseCapabilityInput,
  parseCapabilitySuccess,
  walletConnectionCapability,
  type CanonicalJson,
  type CapabilitySuccess,
  type ReadCapabilityDefinition,
} from "../../core/browser.js";
import { accountAssetApplicationContracts } from "../../account-assets/browser.js";
import { referenceMarketApplicationContracts } from "../../market-portfolio/contracts.js";
import {
  tokenCatalogApplicationContracts,
  tokenInspectCapability,
} from "../../token-catalog/browser.js";

declare const presentationContractEntryType: unique symbol;

export interface PresentationContractEntry<Result = unknown> {
  readonly [presentationContractEntryType]?: Result;
  readonly contract: object;
  readonly contractId: string;
  readonly contractVersion: "1";
  readonly title: string;
  parseInput(value: unknown): CanonicalJson;
  parseResult(input: unknown, value: unknown): CanonicalJson;
  projectText(value: CanonicalJson): string;
}

export type PresentationContractResult<Entry> =
  Entry extends PresentationContractEntry<infer Result> ? Result : never;

interface ApplicationPresentationContract<Input, Result> {
  readonly capabilityId: string;
  readonly contractVersion: "1";
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
    title,
    parseInput: (value: unknown) => captureCanonicalJson(parseCapabilityInput(definition, value)),
    parseResult: (input: unknown, value: unknown) =>
      captureCanonicalJson(parseCapabilitySuccess(definition, input, value)),
    projectText: canonicalJsonStringify,
  });
};

const applicationEntry = <Input, Result>(
  contract: ApplicationPresentationContract<Input, Result>,
  title: string,
): PresentationContractEntry<Result> => {
  return Object.freeze({
    contract,
    contractId: contract.capabilityId,
    contractVersion: contract.contractVersion,
    title,
    parseInput: (value: unknown) => captureCanonicalJson(contract.parseInput(value)),
    parseResult: (input: unknown, value: unknown) =>
      captureCanonicalJson(contract.parsePublicSuccess(input, value)),
    projectText: canonicalJsonStringify,
  });
};

export const presentationContracts = Object.freeze({
  accountAssets: applicationEntry(accountAssetApplicationContracts.collection, "Account assets"),
  contractAnalysis: capabilityEntry(contractInspectCapability, "Contract analysis"),
  referenceHistory: applicationEntry(
    referenceMarketApplicationContracts.history,
    "Reference price history",
  ),
  referencePrice: applicationEntry(referenceMarketApplicationContracts.price, "Reference price"),
  referenceWatchlist: applicationEntry(
    referenceMarketApplicationContracts.watchlist,
    "Reference watchlist",
  ),
  tokenAnalysis: capabilityEntry(tokenInspectCapability, "Token analysis"),
  tokenSelection: applicationEntry(tokenCatalogApplicationContracts.selection, "Token selection"),
  tokenSelections: applicationEntry(
    tokenCatalogApplicationContracts.selections,
    "Token selections",
  ),
  walletConnection: capabilityEntry(walletConnectionCapability, "Wallet connection"),
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
