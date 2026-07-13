import { z } from "zod";

import {
  canonicalJsonStringify,
  compareCodePointSequences,
  coreContractVersion,
  extendCapabilitySchemaProjection,
  fixedIdentifierSchema,
  generalSingleLineTextSchema,
  getCapabilityDefinitionSnapshot,
  projectCapabilities,
  readCapabilityRegistry,
  robinhoodChainIdentity,
  walletConnectionCapability,
  type CanonicalJson,
} from "../core/index.js";
import { guardRuntimeJsonSchema, parseRuntimeAuthority } from "./schema-authority.js";

const walletControlCapabilityIds = Object.freeze([
  "wallet.connect",
  "wallet.disconnect",
  "wallet.list_sessions",
  "wallet.select_session",
] as const);
const readCapabilityIds = Object.freeze(readCapabilityRegistry.values().map((definition) =>
  getCapabilityDefinitionSnapshot(definition).capabilityId));
const walletConnectionCapabilityId = getCapabilityDefinitionSnapshot(walletConnectionCapability).capabilityId;
const chainReadCapabilityIds = Object.freeze(readCapabilityIds
  .filter((capabilityId) => capabilityId !== walletConnectionCapabilityId));
const chainReadCapabilityIdSet: ReadonlySet<string> = new Set(chainReadCapabilityIds);
const expectedCapabilityIds = Object.freeze([...readCapabilityIds, ...walletControlCapabilityIds]
  .sort(compareCodePointSequences));
const walletCapabilityIds = Object.freeze([...walletControlCapabilityIds, walletConnectionCapabilityId]
  .sort(compareCodePointSequences));

const createSupportSchemaSet = () => {
  const availability = z.enum(["unavailable", "internal", "available"]);
  const capabilityAvailability = z.object({
    overall: availability,
    direct: z.enum(["unavailable", "internal"]),
    http: availability,
    mcp: availability,
    cli: availability,
    web: z.literal("unavailable"),
  }).strict().superRefine((value, context) => {
    if (value.direct === "unavailable" && [value.http, value.mcp, value.cli].some((state) => state !== "unavailable")) {
      context.addIssue({ code: "custom", message: "Exposed bindings require an internal direct capability." });
    }
    const userFacing = [value.http, value.mcp, value.cli].includes("available");
    const expectedOverall = userFacing
      ? "available"
      : [value.direct, value.http, value.mcp, value.cli].includes("internal") ? "internal" : "unavailable";
    if (value.overall !== expectedOverall) {
      context.addIssue({ code: "custom", message: "Overall availability must follow exposed bindings." });
    }
  });
  const capabilityManifestEntry = z.object({
    capabilityId: fixedIdentifierSchema,
    availability: capabilityAvailability,
  }).strict();
  const walletCapabilityIdSchema = z.enum(walletCapabilityIds as [string, ...string[]]);
  const interfaceCapabilityIdSchema = z.enum(readCapabilityIds as unknown as [string, ...string[]]);
  const walletChanges = z.array(z.object({
    capabilityId: walletCapabilityIdSchema,
    direct: z.literal("internal").optional(),
    http: z.literal("internal").optional(),
    cli: z.literal("available").optional(),
  }).strict())
    .min(1)
    .max(walletCapabilityIds.length);
  const interfaceBindings = z.array(z.object({
    capabilityId: interfaceCapabilityIdSchema,
    bindings: z.array(z.enum(["http", "mcp", "cli"])).min(1).max(3),
  }).strict()).min(1).max(readCapabilityIds.length);
  const chainSupport = z.object({
    chainId: z.literal(robinhoodChainIdentity.chainId),
    caip2: z.literal(robinhoodChainIdentity.caip2),
    supportLevel: z.literal("L0_discovered"),
    evidence: z.object({
      position: z.literal("source_defined"),
      sourceOwner: z.literal("Robinhood"),
      canonicalUri: z.literal("https://docs.robinhood.com/chain/connecting/"),
      coverage: generalSingleLineTextSchema,
      unsupportedConclusions: z.array(generalSingleLineTextSchema),
    }).strict(),
  }).strict();
  const supportLevel = z.enum(["L0_discovered", "L1_analyzed", "L2_reviewed", "L3_executable", "L4_receipt_verified"]);
  const protocolSupport = z.object({ protocolId: fixedIdentifierSchema, supportLevel }).strict();
  const transactionActionSupport = z.object({ actionId: fixedIdentifierSchema, supportLevel }).strict();
  const manifest = z.object({
    contractVersion: z.literal(coreContractVersion),
    chains: z.array(chainSupport).length(1),
    protocols: z.array(protocolSupport).max(128),
    transactionActions: z.array(transactionActionSupport).max(256),
    capabilities: z.array(capabilityManifestEntry).length(expectedCapabilityIds.length),
  }).strict().superRefine((value, context) => {
    const ids = value.capabilities.map((entry) => entry.capabilityId);
    if (ids.join("\0") !== expectedCapabilityIds.join("\0")) {
      context.addIssue({ code: "custom", message: "Runtime capability support identity is incomplete." });
    }
    for (const entries of [value.protocols, value.transactionActions]) {
      const ids = entries.map((entry) => "protocolId" in entry ? entry.protocolId : entry.actionId);
      for (let index = 1; index < ids.length; index += 1) {
        if (compareCodePointSequences(ids[index - 1] ?? "", ids[index] ?? "") >= 0) {
          context.addIssue({ code: "custom", message: "Support entries must be unique and ordered." });
          break;
        }
      }
    }
  });
  return Object.freeze({
    availability,
    capabilityAvailability,
    walletChanges,
    interfaceBindings,
    manifest,
  });
};

const publicSchemas = createSupportSchemaSet();
const authoritySchemas = createSupportSchemaSet();

export type Availability = z.infer<typeof publicSchemas.availability>;
export const runtimeSupportManifestSchema = guardRuntimeJsonSchema(publicSchemas.manifest);
export type RuntimeSupportManifestSnapshot = z.infer<typeof runtimeSupportManifestSchema>;

type ManifestScope = "initial" | "wallet" | "chain" | "interfaces";
declare const runtimeSupportManifestType: unique symbol;

export interface RuntimeSupportManifest<Scope extends ManifestScope = ManifestScope> {
  readonly [runtimeSupportManifestType]: Scope;
}

export type InitialRuntimeSupportManifest = RuntimeSupportManifest<"initial">;
export type WalletRuntimeSupportManifest = RuntimeSupportManifest<"wallet">;
export type ChainRuntimeSupportManifest = RuntimeSupportManifest<"chain">;
export type InterfaceRuntimeSupportManifest = RuntimeSupportManifest<"interfaces">;

interface ManifestState {
  readonly scope: ManifestScope;
  readonly snapshot: RuntimeSupportManifestSnapshot;
  readonly parent?: RuntimeSupportManifest;
}

const manifestStates = new WeakMap<object, ManifestState>();

const manifestState = (manifest: RuntimeSupportManifest): ManifestState => {
  const state = typeof manifest === "object" && manifest !== null ? manifestStates.get(manifest) : undefined;
  if (state === undefined) throw new TypeError("Runtime support manifest provenance is invalid.");
  return state;
};

const freezeSnapshot = (input: unknown): RuntimeSupportManifestSnapshot => {
  const parsed = parseRuntimeAuthority(authoritySchemas.manifest, input);
  for (const chain of parsed.chains) {
    Object.freeze(chain.evidence.unsupportedConclusions);
    Object.freeze(chain.evidence);
    Object.freeze(chain);
  }
  for (const entry of parsed.capabilities) {
    Object.freeze(entry.availability);
    Object.freeze(entry);
  }
  for (const entry of parsed.protocols) Object.freeze(entry);
  for (const entry of parsed.transactionActions) Object.freeze(entry);
  Object.freeze(parsed.chains);
  Object.freeze(parsed.protocols);
  Object.freeze(parsed.transactionActions);
  Object.freeze(parsed.capabilities);
  return Object.freeze(parsed);
};

const createManifest = (
  scope: ManifestScope,
  snapshot: unknown,
  parent?: RuntimeSupportManifest,
): RuntimeSupportManifest => {
  const manifest = Object.freeze({}) as RuntimeSupportManifest;
  manifestStates.set(manifest, Object.freeze({
    scope,
    snapshot: freezeSnapshot(snapshot),
    ...(parent === undefined ? {} : { parent }),
  }));
  return manifest;
};

const unavailable = Object.freeze({
  overall: "unavailable",
  direct: "unavailable",
  http: "unavailable",
  mcp: "unavailable",
  cli: "unavailable",
  web: "unavailable",
} as const);
export const initialRuntimeSupportManifest = createManifest("initial", {
  contractVersion: coreContractVersion,
  chains: [{
    chainId: robinhoodChainIdentity.chainId,
    caip2: robinhoodChainIdentity.caip2,
    supportLevel: "L0_discovered",
    evidence: {
      position: "source_defined",
      sourceOwner: "Robinhood",
      canonicalUri: "https://docs.robinhood.com/chain/connecting/",
      coverage: "Published Robinhood Chain network identity and chain ID.",
      unsupportedConclusions: ["Endpoint availability.", "Runtime availability.", "Safety."],
    },
  }],
  protocols: [],
  transactionActions: [],
  capabilities: expectedCapabilityIds.map((capabilityId) => ({ capabilityId, availability: unavailable })),
}) as InitialRuntimeSupportManifest;

export const readRuntimeSupportManifest = (
  manifest: RuntimeSupportManifest,
): RuntimeSupportManifestSnapshot => manifestState(manifest).snapshot;

const assertOrderedUnique = (values: readonly string[], expected?: readonly string[]): void => {
  const ordered = [...values].sort(compareCodePointSequences);
  if (new Set(values).size !== values.length || values.join("\0") !== ordered.join("\0") ||
    (expected !== undefined && values.join("\0") !== expected.join("\0"))) {
    throw new TypeError("Runtime support capability identities must be unique and ordered.");
  }
};

const availabilityRank = Object.freeze({ unavailable: 0, internal: 1, available: 2 } as const);

const deriveOverall = (availability: RuntimeSupportManifestSnapshot["capabilities"][number]["availability"]): Availability =>
  [availability.http, availability.mcp, availability.cli].includes("available")
    ? "available"
    : [availability.direct, availability.http, availability.mcp, availability.cli].includes("internal")
      ? "internal"
      : "unavailable";

const assertScopedChild = (
  parent: RuntimeSupportManifest,
  parentScope: ManifestScope,
  extension: RuntimeSupportManifest,
  extensionScope: ManifestScope,
): void => {
  const parentState = manifestState(parent);
  const extensionState = manifestState(extension);
  if (parentState.scope !== parentScope || extensionState.scope !== extensionScope ||
    extensionState.parent !== parent) {
    throw new TypeError("Runtime support manifest scope lineage is invalid.");
  }
};

export const assertWalletRuntimeSupportManifestExtension = (
  parent: InitialRuntimeSupportManifest,
  extension: WalletRuntimeSupportManifest,
): void => assertScopedChild(parent, "initial", extension, "wallet");

export const assertChainRuntimeSupportManifestExtension = (
  parent: WalletRuntimeSupportManifest,
  extension: ChainRuntimeSupportManifest,
): void => assertScopedChild(parent, "wallet", extension, "chain");

export const assertInterfaceRuntimeSupportManifestExtension = (
  parent: ChainRuntimeSupportManifest,
  extension: InterfaceRuntimeSupportManifest,
): void => assertScopedChild(parent, "chain", extension, "interfaces");

export const extendWalletRuntimeSupportManifest = (
  parent: InitialRuntimeSupportManifest,
  changesInput: unknown,
): WalletRuntimeSupportManifest => {
  const parentState = manifestState(parent);
  if (parentState.scope !== "initial") throw new TypeError("Wallet support requires the initial manifest.");
  const changes = parseRuntimeAuthority(authoritySchemas.walletChanges, changesInput);
  const capabilityIds = changes.map((change) => change.capabilityId);
  assertOrderedUnique(capabilityIds);
  const changesById = new Map(changes.map((change) => [change.capabilityId, change]));
  const capabilities = parentState.snapshot.capabilities.map((entry) => {
    const change = changesById.get(entry.capabilityId);
    if (change === undefined) return entry;
    const keys = Object.keys(change).filter((key) => key !== "capabilityId");
    if (keys.length === 0) throw new TypeError("Wallet support change is empty.");
    const next = { ...entry.availability };
    if (change.direct !== undefined) {
      if (availabilityRank[change.direct] <= availabilityRank[next.direct]) {
        throw new TypeError("Wallet support changes must move availability forward.");
      }
      next.direct = change.direct;
    }
    if (change.http !== undefined) {
      if (availabilityRank[change.http] <= availabilityRank[next.http]) {
        throw new TypeError("Wallet support changes must move availability forward.");
      }
      next.http = change.http;
    }
    if (change.cli !== undefined) {
      if (availabilityRank[change.cli] <= availabilityRank[next.cli]) {
        throw new TypeError("Wallet support changes must move availability forward.");
      }
      next.cli = change.cli;
    }
    next.overall = deriveOverall(next);
    return Object.freeze({ ...entry, availability: Object.freeze(next) });
  });
  const extension = createManifest("wallet", {
    ...parentState.snapshot,
    capabilities,
  }, parent) as WalletRuntimeSupportManifest;
  assertWalletRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

export const extendChainRuntimeSupportManifest = (
  parent: WalletRuntimeSupportManifest,
): ChainRuntimeSupportManifest => {
  const parentState = manifestState(parent);
  if (parentState.scope !== "wallet") throw new TypeError("Chain support requires the wallet manifest.");
  assertOrderedUnique(chainReadCapabilityIds, chainReadCapabilityIds);
  const capabilities = parentState.snapshot.capabilities.map((entry) => {
    if (!chainReadCapabilityIdSet.has(entry.capabilityId)) return entry;
    if (entry.availability.direct !== "unavailable") {
      throw new TypeError("Chain read direct support already exists.");
    }
    const availability = { ...entry.availability, direct: "internal" as const };
    availability.overall = deriveOverall(availability);
    return Object.freeze({ ...entry, availability: Object.freeze(availability) });
  });
  const extension = createManifest("chain", {
    ...parentState.snapshot,
    capabilities,
  }, parent) as ChainRuntimeSupportManifest;
  assertChainRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

export const extendInterfaceRuntimeSupportManifest = (
  parent: ChainRuntimeSupportManifest,
  bindingsInput: unknown,
): InterfaceRuntimeSupportManifest => {
  const parentState = manifestState(parent);
  if (parentState.scope !== "chain") throw new TypeError("Interface support requires the chain manifest.");
  const bindings = parseRuntimeAuthority(authoritySchemas.interfaceBindings, bindingsInput);
  const capabilityIds = bindings.map((entry) => entry.capabilityId);
  assertOrderedUnique(capabilityIds);
  for (const entry of bindings) {
    const orderedBindings = [...entry.bindings].sort(compareCodePointSequences);
    if (new Set(entry.bindings).size !== entry.bindings.length ||
      entry.bindings.join("\0") !== orderedBindings.join("\0")) {
      throw new TypeError("Interface binding identities must be unique and ordered.");
    }
  }
  const bindingsById = new Map(bindings.map((entry) => [entry.capabilityId, entry.bindings]));
  const capabilities = parentState.snapshot.capabilities.map((entry) => {
    const exposedBindings = bindingsById.get(entry.capabilityId);
    if (exposedBindings === undefined) return entry;
    if (entry.availability.direct !== "internal") {
      throw new TypeError("An interface cannot expose an unavailable direct capability.");
    }
    const availability = {
      ...entry.availability,
      overall: "available" as const,
      http: exposedBindings.includes("http") ? "available" as const : entry.availability.http,
      mcp: exposedBindings.includes("mcp") ? "available" as const : entry.availability.mcp,
      cli: exposedBindings.includes("cli") ? "available" as const : entry.availability.cli,
    };
    if (availability.http === entry.availability.http && availability.mcp === entry.availability.mcp &&
      availability.cli === entry.availability.cli) {
      throw new TypeError("Interface support binding does not add an exposed capability.");
    }
    return Object.freeze({ ...entry, availability: Object.freeze(availability) });
  });
  const extension = createManifest(
    "interfaces",
    { ...parentState.snapshot, capabilities },
    parent,
  ) as InterfaceRuntimeSupportManifest;
  assertInterfaceRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

const currentSupportMarker = "<!-- Generated from the runtime support manifest. Do not edit this section. -->";

export const renderCurrentSupportSection = (manifest: RuntimeSupportManifest): string => {
  const snapshot = readRuntimeSupportManifest(manifest);
  const chain = snapshot.chains[0];
  if (chain === undefined) throw new TypeError("Robinhood Chain support is unavailable.");
  const availableCapabilities = snapshot.capabilities
    .filter((entry) => entry.availability.overall === "available")
    .map((entry) => `\`${entry.capabilityId}\``);
  const walletCliAvailable = walletCapabilityIds.every((capabilityId) =>
    snapshot.capabilities.find((entry) => entry.capabilityId === capabilityId)?.availability.cli === "available");
  const displayLevel = (level: string): string => level.replace("_", " ");
  const protocols = snapshot.protocols.map((entry) => `\`${entry.protocolId}\` (${displayLevel(entry.supportLevel)})`);
  const transactionActions = snapshot.transactionActions.map((entry) => `\`${entry.actionId}\` (${displayLevel(entry.supportLevel)})`);
  return [
    "## Current Support",
    "",
    currentSupportMarker,
    "",
    "- Runtime support manifest: implemented as the sole machine authority for the",
    "  values in this section.",
    `- Robinhood Chain: \`${displayLevel(chain.supportLevel)}\`. The official network configuration identifies`,
    `  Robinhood Chain mainnet with chain ID \`${chain.chainId}\` in the`,
    `  [Robinhood Chain documentation](${chain.evidence.canonicalUri}).`,
    `  Source owner: ${chain.evidence.sourceOwner}. Coverage: ${chain.evidence.coverage}`,
    `  Unsupported conclusions: ${chain.evidence.unsupportedConclusions.join(" ")}`,
    protocols.length === 0 ? "- Implemented protocol support: none." : `- Implemented protocol support: ${protocols.join(", ")}.`,
    walletCliAvailable
      ? "- Implemented wallet support: WalletConnect connection through the interactive CLI."
      : "- Implemented wallet support: none.",
    transactionActions.length === 0
      ? "- Implemented transaction actions: none."
      : `- Implemented transaction actions: ${transactionActions.join(", ")}.`,
    availableCapabilities.length === 0
      ? "- Available user-facing capabilities: none."
      : `- Available user-facing capabilities: ${availableCapabilities.join(", ")}.`,
    "- Experiments and collected research do not establish product support.",
  ].join("\n") + "\n";
};

const currentSupportPattern = /## Current Support\n[\s\S]*?(?=\n## [^#]|$)/g;

const oneCurrentSupportSection = (document: string): RegExpMatchArray => {
  const sections = [...document.matchAll(currentSupportPattern)];
  const markers = document.split(currentSupportMarker).length - 1;
  if (sections.length !== 1 || markers !== 1 || sections[0] === undefined || sections[0].index === undefined) {
    throw new TypeError("Current Support projection identity is invalid.");
  }
  return sections[0];
};

export const projectCurrentSupportDocument = (
  document: string,
  manifest: RuntimeSupportManifest,
): string => {
  const section = oneCurrentSupportSection(document);
  const start = section.index as number;
  return `${document.slice(0, start)}${renderCurrentSupportSection(manifest)}${document.slice(start + section[0].length)}`;
};

export const verifyCurrentSupportDocument = (
  document: string,
  manifest: RuntimeSupportManifest,
): void => {
  if (projectCurrentSupportDocument(document, manifest) !== document) {
    throw new Error("The public Current Support projection is not synchronized.");
  }
};

const publicCatalogEntrySchema = extendCapabilitySchemaProjection({ availability: publicSchemas.capabilityAvailability });
const authorityCatalogEntrySchema = extendCapabilitySchemaProjection({ availability: authoritySchemas.capabilityAvailability });
const publicCatalogSchema = z.object({
  contractVersion: z.literal(coreContractVersion),
  capabilities: z.array(publicCatalogEntrySchema).length(readCapabilityIds.length),
}).strict();
const authorityCatalogSchema = z.object({
  contractVersion: z.literal(coreContractVersion),
  capabilities: z.array(authorityCatalogEntrySchema).length(readCapabilityIds.length),
}).strict();

export const capabilityCatalogSchema = guardRuntimeJsonSchema(publicCatalogSchema);
export type CapabilityCatalog = z.infer<typeof capabilityCatalogSchema>;

export const composeCapabilityCatalog = (
  manifest: RuntimeSupportManifest,
): CapabilityCatalog => {
  const snapshot = readRuntimeSupportManifest(manifest);
  const availability = new Map<string, RuntimeSupportManifestSnapshot["capabilities"][number]["availability"]>(
    snapshot.capabilities.map((entry) => [entry.capabilityId, entry.availability]),
  );
  const capabilities = projectCapabilities(readCapabilityRegistry).map((projection) => {
    const state = availability.get(projection.capabilityId);
    if (state === undefined) throw new TypeError("Registered capability has no support entry.");
    return { ...projection, availability: state };
  });
  const catalog = parseRuntimeAuthority(authorityCatalogSchema, {
    contractVersion: coreContractVersion,
    capabilities,
  });
  canonicalJsonStringify(catalog as unknown as CanonicalJson);
  return Object.freeze({
    ...catalog,
    capabilities: Object.freeze(catalog.capabilities),
  }) as unknown as CapabilityCatalog;
};
