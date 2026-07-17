import { z } from "zod";

import {
  canonicalJsonStringify,
  capabilityIdSchema,
  compareCodePointSequences,
  coreContractVersion,
  evmChainIdSchema,
  extendCapabilitySchemaProjection,
  fixedIdentifierSchema,
  generalSingleLineTextSchema,
  getCapabilityDefinitionSnapshot,
  parseEvmChainId,
  projectCapabilities,
  readCapabilityRegistry,
  walletConnectionCapability,
  type CanonicalJson,
} from "../core/index.js";
import {
  readRuntimeChainConfiguration,
  type RuntimeChainConfiguration,
} from "./configuration.js";
import { guardRuntimeJsonSchema, parseRuntimeAuthority } from "./schema-authority.js";

const readCapabilityIds = Object.freeze(readCapabilityRegistry.values().map((definition) =>
  getCapabilityDefinitionSnapshot(definition).capabilityId));
const walletConnectionCapabilityId = getCapabilityDefinitionSnapshot(walletConnectionCapability).capabilityId;

const createSupportSchemaSet = () => {
  const availability = z.enum(["unavailable", "internal", "available"]);
  const capabilityAvailability = z.object({
    overall: availability,
    direct: z.enum(["unavailable", "internal"]),
    http: availability,
    mcp: availability,
    cli: availability,
    web: availability,
  }).strict().superRefine((value, context) => {
    if (value.direct === "unavailable" && [value.http, value.mcp, value.cli, value.web]
      .some((state) => state !== "unavailable")) {
      context.addIssue({ code: "custom", message: "Exposed bindings require an internal direct capability." });
    }
    const userFacing = [value.http, value.mcp, value.cli, value.web].includes("available");
    const expectedOverall = userFacing
      ? "available"
      : [value.direct, value.http, value.mcp, value.cli, value.web].includes("internal") ? "internal" : "unavailable";
    if (value.overall !== expectedOverall) {
      context.addIssue({ code: "custom", message: "Overall availability must follow exposed bindings." });
    }
  });
  const capabilityManifestEntry = z.object({
    capabilityId: capabilityIdSchema,
    availability: capabilityAvailability,
  }).strict();
  const capabilityExtension = z.object({
    registrations: z.array(capabilityManifestEntry),
    changes: z.array(capabilityManifestEntry),
  }).strict().superRefine((value, context) => {
    if (value.registrations.length === 0 && value.changes.length === 0) {
      context.addIssue({ code: "custom", message: "A support extension cannot be empty." });
    }
  });
  const chainSupport = z.object({
    chainId: evmChainIdSchema,
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
    capabilities: z.array(capabilityManifestEntry).min(readCapabilityIds.length),
  }).strict().superRefine((value, context) => {
    const ids = value.capabilities.map((entry) => entry.capabilityId);
    for (let index = 1; index < ids.length; index += 1) {
      if (compareCodePointSequences(ids[index - 1] ?? "", ids[index] ?? "") >= 0) {
        context.addIssue({ code: "custom", message: "Capability support entries must be unique and ordered." });
        break;
      }
    }
    if (readCapabilityIds.some((capabilityId) => !ids.includes(capabilityId))) {
      context.addIssue({ code: "custom", message: "A canonical read capability support identity is missing." });
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
    capabilityExtension,
    manifest,
  });
};

const publicSchemas = createSupportSchemaSet();
const authoritySchemas = createSupportSchemaSet();

export type Availability = z.infer<typeof publicSchemas.availability>;
export type CapabilityAvailabilityInput = Readonly<z.infer<typeof publicSchemas.capabilityAvailability>>;
export interface CapabilitySupportEntryInput {
  readonly capabilityId: string;
  readonly availability: CapabilityAvailabilityInput;
}
export interface RuntimeSupportManifestExtensionInput {
  readonly registrations: readonly CapabilitySupportEntryInput[];
  readonly changes: readonly CapabilitySupportEntryInput[];
}
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
export const createInitialRuntimeSupportManifest = (
  chain: RuntimeChainConfiguration,
): InitialRuntimeSupportManifest => {
  const chainId = parseEvmChainId(readRuntimeChainConfiguration(chain).chainId);
  return createManifest("initial", {
    contractVersion: coreContractVersion,
    chains: [{
      chainId,
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
    capabilities: readCapabilityIds.map((capabilityId) => ({ capabilityId, availability: unavailable })),
  }) as InitialRuntimeSupportManifest;
};

export const readRuntimeSupportManifest = (
  manifest: RuntimeSupportManifest,
): RuntimeSupportManifestSnapshot => manifestState(manifest).snapshot;

const assertOrderedUnique = (values: readonly string[]): void => {
  const ordered = [...values].sort(compareCodePointSequences);
  if (new Set(values).size !== values.length || values.join("\0") !== ordered.join("\0")) {
    throw new TypeError("Runtime support capability identities must be unique and ordered.");
  }
};

const availabilityRank = Object.freeze({ unavailable: 0, internal: 1, available: 2 } as const);

type CapabilityAvailability = RuntimeSupportManifestSnapshot["capabilities"][number]["availability"];

const assertAvailabilityMovesForward = (
  previous: CapabilityAvailability,
  next: CapabilityAvailability,
): void => {
  let advanced = false;
  for (const binding of ["direct", "http", "mcp", "cli", "web"] as const) {
    if (availabilityRank[next[binding]] < availabilityRank[previous[binding]]) {
      throw new TypeError("Support availability cannot move backward.");
    }
    if (availabilityRank[next[binding]] > availabilityRank[previous[binding]]) advanced = true;
  }
  if (!advanced) throw new TypeError("Support availability change does not move forward.");
};

const applyCapabilityExtension = (
  snapshot: RuntimeSupportManifestSnapshot,
  input: unknown,
): RuntimeSupportManifestSnapshot["capabilities"] => {
  const extension = parseRuntimeAuthority(authoritySchemas.capabilityExtension, input);
  const registrationIds = extension.registrations.map((entry) => entry.capabilityId);
  const changeIds = extension.changes.map((entry) => entry.capabilityId);
  assertOrderedUnique(registrationIds);
  assertOrderedUnique(changeIds);
  const existing = new Map(snapshot.capabilities.map((entry) => [entry.capabilityId, entry]));
  for (const entry of extension.registrations) {
    if (existing.has(entry.capabilityId)) throw new TypeError("Capability support identity is already registered.");
    existing.set(entry.capabilityId, entry);
  }
  for (const entry of extension.changes) {
    const previous = existing.get(entry.capabilityId);
    if (previous === undefined || registrationIds.includes(entry.capabilityId)) {
      throw new TypeError("Capability support change requires a previously registered identity.");
    }
    assertAvailabilityMovesForward(previous.availability, entry.availability);
    existing.set(entry.capabilityId, entry);
  }
  return Object.freeze([...existing.values()]
    .sort((left, right) => compareCodePointSequences(left.capabilityId, right.capabilityId))
    .map((entry) => Object.freeze({
      capabilityId: entry.capabilityId,
      availability: Object.freeze({ ...entry.availability }),
    }))) as unknown as RuntimeSupportManifestSnapshot["capabilities"];
};

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
  extensionInput: RuntimeSupportManifestExtensionInput,
): WalletRuntimeSupportManifest => {
  const parentState = manifestState(parent);
  if (parentState.scope !== "initial") throw new TypeError("Wallet support requires the initial manifest.");
  const extension = createManifest("wallet", {
    ...parentState.snapshot,
    capabilities: applyCapabilityExtension(parentState.snapshot, extensionInput),
  }, parent) as WalletRuntimeSupportManifest;
  assertWalletRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

export const extendChainRuntimeSupportManifest = (
  parent: WalletRuntimeSupportManifest,
  extensionInput: RuntimeSupportManifestExtensionInput,
): ChainRuntimeSupportManifest => {
  const parentState = manifestState(parent);
  if (parentState.scope !== "wallet") throw new TypeError("Chain support requires the wallet manifest.");
  const extension = createManifest("chain", {
    ...parentState.snapshot,
    capabilities: applyCapabilityExtension(parentState.snapshot, extensionInput),
  }, parent) as ChainRuntimeSupportManifest;
  assertChainRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

export const extendInterfaceRuntimeSupportManifest = (
  parent: ChainRuntimeSupportManifest,
  extensionInput: RuntimeSupportManifestExtensionInput,
): InterfaceRuntimeSupportManifest => {
  const parentState = manifestState(parent);
  if (parentState.scope !== "chain") throw new TypeError("Interface support requires the chain manifest.");
  const extension = createManifest(
    "interfaces",
    { ...parentState.snapshot, capabilities: applyCapabilityExtension(parentState.snapshot, extensionInput) },
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
  const walletConnectionAvailability = snapshot.capabilities
    .find((entry) => entry.capabilityId === walletConnectionCapabilityId)?.availability;
  const walletCapabilities = snapshot.capabilities
    .filter((entry) => entry.capabilityId.startsWith("wallet."));
  const exposedBindingLabels = (availability: CapabilityAvailability): readonly string[] => Object.freeze([
    availability.http === "available" ? "HTTP" : undefined,
    availability.mcp === "available" ? "MCP" : undefined,
    availability.cli === "available" ? "CLI" : undefined,
    availability.web === "available" ? "web" : undefined,
  ].filter((value): value is string => value !== undefined));
  const walletSupport = walletCapabilities
    .filter((entry) => entry.availability.overall === "available")
    .map((entry) => `\`${entry.capabilityId}\` (${exposedBindingLabels(entry.availability).join(", ")})`);
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
    `  Robinhood Chain mainnet in the [Robinhood Chain documentation](${chain.evidence.canonicalUri}).`,
    `  Little John's canonical chain ID for that network is \`${chain.chainId}\`.`,
    `  Source owner: ${chain.evidence.sourceOwner}. Coverage: ${chain.evidence.coverage}`,
    `  Unsupported conclusions: ${chain.evidence.unsupportedConclusions.join(" ")}`,
    protocols.length === 0 ? "- Implemented protocol support: none." : `- Implemented protocol support: ${protocols.join(", ")}.`,
    walletSupport.length === 0
      ? "- Implemented wallet support: none."
      : `- Implemented wallet support: ${walletSupport.join("; ")}.`,
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
