import { captureCanonicalJson } from "../core/index.js";
import { z } from "zod";

import {canonicalJsonStringify, capabilityIdSchema, compareCodePointSequences, isStrictlyOrderedUnique, deepFreezeValue, extendCapabilitySchemaProjection, fixedIdentifierSchema, generalSingleLineTextSchema, getCapabilityDefinitionSnapshot, officialIdentityEvidenceSchema, projectCapabilities, supportLevelDefinitions, supportLevelSchema, type CapabilityRegistry, type CapabilitySchemaProjection, type CanonicalJson, type OfficialIdentityEvidence, type SupportLevel} from "../core/index.js";
import {readCapabilityRegistry} from "./read-capabilities.js";
import {evmChainIdSchema, parseEvmChainId} from "../evm/identities.js";
import {walletConnectionCapability} from "../wallet/connection-capability.js";
import {
  readRuntimeChainConfiguration,
  type RuntimeChainConfiguration,
} from "./configuration.js";
import { guardRuntimeJsonSchema, parseRuntimeAuthority } from "./schema-authority.js";

const runtimeSupportManifestContractVersion = "5" as const;
const runtimeProtocolSupportEntryLimit = 128 as const;
const runtimePresentationSupportEntryLimit = 256 as const;

const availabilityDefinitions = Object.freeze(["unavailable", "internal", "available"] as const);
export type Availability = typeof availabilityDefinitions[number];
const directAvailabilityDefinitions = Object.freeze([
  availabilityDefinitions[0],
  availabilityDefinitions[1],
] as const);
const unavailableAvailability = availabilityDefinitions[0];
const internalAvailability = availabilityDefinitions[1];
const availableAvailability = availabilityDefinitions[2];

type CapabilityAvailabilityAxes = Readonly<{
  direct: typeof directAvailabilityDefinitions[number];
  http: Availability;
  mcp: Availability;
  cli: Availability;
}>;

const deriveOverallAvailability = (
  axes: CapabilityAvailabilityAxes,
): Availability =>
  [axes.http, axes.mcp, axes.cli].includes(availableAvailability)
    ? availableAvailability
    : [axes.direct, axes.http, axes.mcp, axes.cli]
        .includes(internalAvailability)
      ? internalAvailability
      : unavailableAvailability;

const initialReadCapabilityIds = Object.freeze(readCapabilityRegistry.values().map((definition) =>
  getCapabilityDefinitionSnapshot(definition).capabilityId));
const walletConnectionCapabilityId = getCapabilityDefinitionSnapshot(walletConnectionCapability).capabilityId;

const createSupportSchemaSet = () => {
  const availability = z.enum(availabilityDefinitions);
  const capabilityAvailability = z.object({
    overall: availability,
    direct: z.enum(directAvailabilityDefinitions),
    http: availability,
    mcp: availability,
    cli: availability,
  }).strict().superRefine((value, context) => {
    if (value.direct === unavailableAvailability && [value.http, value.mcp, value.cli]
      .some((state) => state !== unavailableAvailability)) {
      context.addIssue({ code: "custom", message: "Exposed bindings require an internal direct capability." });
    }
    const expectedOverall = deriveOverallAvailability(value);
    if (value.overall !== expectedOverall) {
      context.addIssue({ code: "custom", message: "Overall availability must follow exposed bindings." });
    }
  });
  const capabilityManifestEntry = z.object({
    capabilityId: capabilityIdSchema,
    availability: capabilityAvailability,
  }).strict();
  const presentationManifestEntry = z.object({
    contractId: capabilityIdSchema,
    contractVersion: z.string().regex(/^[1-9][0-9]*$/u),
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
    supportLevel: z.literal(supportLevelDefinitions[0]),
    evidence: z.object({
      position: z.literal("source_defined"),
      sourceOwner: z.literal("Robinhood"),
      canonicalUri: z.literal("https://docs.robinhood.com/chain/connecting/"),
      coverage: generalSingleLineTextSchema,
      unsupportedConclusions: z.array(generalSingleLineTextSchema),
    }).strict(),
  }).strict();
  const protocolSupport = z.object({
    protocolId: fixedIdentifierSchema,
    supportLevel: supportLevelSchema,
    identityEvidence: officialIdentityEvidenceSchema,
  }).strict();
  const transactionActionSupport = z.object({ actionId: capabilityIdSchema, contractVersion: z.string().regex(/^[1-9][0-9]*$/u),
    protocolId: fixedIdentifierSchema, supportLevel: supportLevelSchema }).strict();
  const protocolExtension = z.object({
    transactionActions: z.array(transactionActionSupport).optional(),
    protocols: z.array(protocolSupport).max(runtimeProtocolSupportEntryLimit),
    registrations: z.array(capabilityManifestEntry),
    changes: z.array(capabilityManifestEntry),
  }).strict().superRefine((value, context) => {
    if (
      value.protocols.length === 0 &&
      value.registrations.length === 0 &&
      value.changes.length === 0
    ) {
      context.addIssue({ code: "custom", message: "A protocol support extension cannot be empty." });
    }
  });
  const manifest = z.object({
    contractVersion: z.literal(runtimeSupportManifestContractVersion),
    chains: z.array(chainSupport).length(1),
    protocols: z.array(protocolSupport).max(runtimeProtocolSupportEntryLimit),
    transactionActions: z.array(transactionActionSupport),
    capabilities: z.array(capabilityManifestEntry).min(initialReadCapabilityIds.length),
    presentations: z.array(presentationManifestEntry).max(runtimePresentationSupportEntryLimit),
  }).strict().superRefine((value, context) => {
    if (!isStrictlyOrderedUnique(value.transactionActions.map((entry) => `${entry.protocolId}\0${entry.actionId}`)) ||
        value.transactionActions.some((entry) => !value.protocols.some((protocol) => protocol.protocolId === entry.protocolId))) {
      context.addIssue({ code: "custom", message: "Transaction action support must have a unique registered protocol owner." });
    }
    const ids = value.capabilities.map((entry) => entry.capabilityId);
    if (!isStrictlyOrderedUnique(ids)) {
      context.addIssue({ code: "custom", message: "Capability support entries must be unique and ordered." });
    }
    if (initialReadCapabilityIds.some((capabilityId) => !ids.includes(capabilityId))) {
      context.addIssue({ code: "custom", message: "A canonical read capability support identity is missing." });
    }
    const presentationIds = value.presentations.map((entry) =>
      `${entry.contractId}\0${entry.contractVersion}`);
    if (!isStrictlyOrderedUnique(presentationIds)) {
      context.addIssue({ code: "custom", message: "Presentation support entries must be unique and ordered." });
    }
    const capabilityAvailability = new Map(value.capabilities.map((entry) =>
      [entry.capabilityId, entry.availability] as const));
    for (const presentation of value.presentations) {
      if (capabilityAvailability.get(presentation.contractId)?.mcp !== availableAvailability) {
        context.addIssue({
          code: "custom",
          message: "Presentation support requires an available canonical MCP capability.",
        });
        break;
      }
    }
    const protocolIds = value.protocols.map((entry) => entry.protocolId);
    if (!isStrictlyOrderedUnique(protocolIds)) {
      context.addIssue({ code: "custom", message: "Support entries must be unique and ordered." });
    }
  });
  return Object.freeze({
    availability,
    capabilityAvailability,
    capabilityExtension,
    presentationManifestEntry,
    protocolExtension,
    manifest,
  });
};

const publicSchemas = createSupportSchemaSet();
const authoritySchemas = createSupportSchemaSet();

export type CapabilityAvailabilityInput = Readonly<z.infer<typeof publicSchemas.capabilityAvailability>>;
export type CapabilityAvailabilityAxesInput = Omit<
  CapabilityAvailabilityInput,
  "overall"
>;
export const createCapabilityAvailability = (
  axes: CapabilityAvailabilityAxesInput,
): CapabilityAvailabilityInput => Object.freeze({
  direct: axes.direct,
  http: axes.http,
  mcp: axes.mcp,
  cli: axes.cli,
  overall: deriveOverallAvailability(axes),
});
export interface CapabilitySupportEntryInput {
  readonly capabilityId: string;
  readonly availability: CapabilityAvailabilityInput;
}
export interface RuntimeSupportManifestExtensionInput {
  readonly registrations: readonly CapabilitySupportEntryInput[];
  readonly changes: readonly CapabilitySupportEntryInput[];
}
export interface PresentationSupportEntryInput {
  readonly contractId: string;
  readonly contractVersion: string;
}
export interface RuntimeInterfaceSupportManifestExtensionInput
  extends RuntimeSupportManifestExtensionInput {
  readonly presentations: readonly PresentationSupportEntryInput[];
}
export interface ProtocolSupportEntryInput {
  readonly protocolId: string;
  readonly supportLevel: SupportLevel;
  readonly identityEvidence: OfficialIdentityEvidence;
}
export interface RuntimeProtocolSupportManifestExtensionInput
  extends RuntimeSupportManifestExtensionInput {
  readonly protocols: readonly ProtocolSupportEntryInput[];
  readonly transactionActions?: readonly TransactionActionSupportInput[];
}
export interface TransactionActionSupportInput {
  readonly actionId: string; readonly contractVersion: string; readonly protocolId: string; readonly supportLevel: SupportLevel;
}
export const runtimeSupportManifestSchema = guardRuntimeJsonSchema(publicSchemas.manifest);
export type RuntimeSupportManifestSnapshot = z.infer<typeof runtimeSupportManifestSchema>;

type ManifestScope =
  | "initial"
  | "wallet"
  | "chain"
  | "token_catalog"
  | "account_assets"
  | "stock_token_trade_history"
  | "stock_token_prices"
  | "protocols"
  | "interfaces"
  | "composition";
declare const runtimeSupportManifestType: unique symbol;

export interface RuntimeSupportManifest {
  readonly [runtimeSupportManifestType]: true;
}


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
  for (const entry of parsed.presentations) Object.freeze(entry);
  for (const entry of parsed.protocols) deepFreezeValue(entry);
  Object.freeze(parsed.chains);
  Object.freeze(parsed.protocols);
  for (const entry of parsed.transactionActions) Object.freeze(entry);
  Object.freeze(parsed.transactionActions);
  Object.freeze(parsed.capabilities);
  Object.freeze(parsed.presentations);
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
  overall: unavailableAvailability,
  direct: unavailableAvailability,
  http: unavailableAvailability,
  mcp: unavailableAvailability,
  cli: unavailableAvailability,
} as const);
export const createInitialRuntimeSupportManifest = (
  chain: RuntimeChainConfiguration,
): RuntimeSupportManifest => {
  const chainId = parseEvmChainId(readRuntimeChainConfiguration(chain).chainId);
  return createManifest("initial", {
    contractVersion: runtimeSupportManifestContractVersion,
    chains: [{
      chainId,
      supportLevel: supportLevelDefinitions[0],
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
    capabilities: initialReadCapabilityIds.map((capabilityId) => ({ capabilityId, availability: unavailable })),
    presentations: [],
  }) as RuntimeSupportManifest;
};

export const readRuntimeSupportManifest = (
  manifest: RuntimeSupportManifest,
): RuntimeSupportManifestSnapshot => manifestState(manifest).snapshot;

const assertOrderedUnique = (values: readonly string[]): void => {
  if (!isStrictlyOrderedUnique(values)) {
    throw new TypeError("Runtime support capability identities must be unique and ordered.");
  }
};

const availabilityRank = (availability: Availability): number =>
  availabilityDefinitions.indexOf(availability);

type CapabilityAvailability = RuntimeSupportManifestSnapshot["capabilities"][number]["availability"];

const assertAvailabilityMovesForward = (
  previous: CapabilityAvailability,
  next: CapabilityAvailability,
): void => {
  let advanced = false;
  for (const binding of ["direct", "http", "mcp", "cli"] as const) {
    if (availabilityRank(next[binding]) < availabilityRank(previous[binding])) {
      throw new TypeError("Support availability cannot move backward.");
    }
    if (availabilityRank(next[binding]) > availabilityRank(previous[binding])) advanced = true;
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

const applyProtocolExtension = (
  snapshot: RuntimeSupportManifestSnapshot,
  input: RuntimeProtocolSupportManifestExtensionInput,
): RuntimeSupportManifestSnapshot["protocols"] => {
  const extension = parseRuntimeAuthority(authoritySchemas.protocolExtension, input);
  const protocolIds = extension.protocols.map((entry) => entry.protocolId);
  assertOrderedUnique(protocolIds);
  const existing = new Map(snapshot.protocols.map((entry) => [entry.protocolId, entry]));
  for (const entry of extension.protocols) {
    if (existing.has(entry.protocolId)) {
      throw new TypeError("Protocol support identity is already registered.");
    }
    existing.set(entry.protocolId, entry);
  }
  return Object.freeze([...existing.values()]
    .sort((left, right) => compareCodePointSequences(left.protocolId, right.protocolId))
    .map((entry) => deepFreezeValue({ ...entry }))) as RuntimeSupportManifestSnapshot["protocols"];
};

const assertScopedChild = (
  parent: RuntimeSupportManifest,
  extension: RuntimeSupportManifest,
  extensionScope: ManifestScope,
): void => {
  manifestState(parent);
  const extensionState = manifestState(extension);
  if (extensionState.scope !== extensionScope ||
    extensionState.parent !== parent) {
    throw new TypeError("Runtime support manifest scope lineage is invalid.");
  }
};

export const assertWalletRuntimeSupportManifestExtension = (
  parent: RuntimeSupportManifest,
  extension: RuntimeSupportManifest,
): void => assertScopedChild(parent, extension, "wallet");

export const assertChainRuntimeSupportManifestExtension = (
  parent: RuntimeSupportManifest,
  extension: RuntimeSupportManifest,
): void => assertScopedChild(parent, extension, "chain");

export const assertProtocolRuntimeSupportManifestExtension = (
  parent: RuntimeSupportManifest,
  extension: RuntimeSupportManifest,
): void => assertScopedChild(parent, extension, "protocols");

export const assertStockTokenPriceRuntimeSupportManifestExtension = (
  parent: RuntimeSupportManifest,
  extension: RuntimeSupportManifest,
): void => assertScopedChild(parent, extension, "stock_token_prices");

export const assertInterfaceRuntimeSupportManifestExtension = (
  parent: RuntimeSupportManifest,
  extension: RuntimeSupportManifest,
): void => assertScopedChild(parent, extension, "interfaces");

export const assertStockTokenTradeHistoryRuntimeSupportManifestExtension = (
  parent: RuntimeSupportManifest,
  extension: RuntimeSupportManifest,
): void => assertScopedChild(parent, extension, "stock_token_trade_history");

export const assertAccountAssetRuntimeSupportManifestExtension = (
  parent: RuntimeSupportManifest,
  extension: RuntimeSupportManifest,
): void => assertScopedChild(parent, extension, "account_assets");

export const assertTokenCatalogRuntimeSupportManifestExtension = (
  parent: RuntimeSupportManifest,
  extension: RuntimeSupportManifest,
): void => assertScopedChild(parent, extension, "token_catalog");

export const extendWalletRuntimeSupportManifest = (
  parent: RuntimeSupportManifest,
  extensionInput: RuntimeSupportManifestExtensionInput,
): RuntimeSupportManifest => {
  const parentState = manifestState(parent);
  const extension = createManifest("wallet", {
    ...parentState.snapshot,
    capabilities: applyCapabilityExtension(parentState.snapshot, extensionInput),
  }, parent) as RuntimeSupportManifest;
  assertWalletRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

export const extendChainRuntimeSupportManifest = (
  parent: RuntimeSupportManifest,
  extensionInput: RuntimeSupportManifestExtensionInput,
): RuntimeSupportManifest => {
  const parentState = manifestState(parent);
  const extension = createManifest("chain", {
    ...parentState.snapshot,
    capabilities: applyCapabilityExtension(parentState.snapshot, extensionInput),
  }, parent) as RuntimeSupportManifest;
  assertChainRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

export const extendProtocolRuntimeSupportManifest = (
  parent: RuntimeSupportManifest,
  extensionInput: RuntimeProtocolSupportManifestExtensionInput,
): RuntimeSupportManifest => {
  const parentState = manifestState(parent);
  const extension = createManifest("protocols", {
    ...parentState.snapshot,
    protocols: applyProtocolExtension(parentState.snapshot, extensionInput),
    transactionActions: [...parentState.snapshot.transactionActions, ...(extensionInput.transactionActions ?? [])],
    capabilities: applyCapabilityExtension(parentState.snapshot, {
      registrations: extensionInput.registrations,
      changes: extensionInput.changes,
    }),
  }, parent) as RuntimeSupportManifest;
  assertProtocolRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

export const extendInterfaceRuntimeSupportManifest = (
  parent: RuntimeSupportManifest,
  extensionInput: RuntimeInterfaceSupportManifestExtensionInput,
): RuntimeSupportManifest => {
  const parentState = manifestState(parent);
  const presentations = parseRuntimeAuthority(
    z.array(authoritySchemas.presentationManifestEntry)
      .max(runtimePresentationSupportEntryLimit),
    extensionInput.presentations,
  );
  assertOrderedUnique(presentations.map((entry) => `${entry.contractId}\0${entry.contractVersion}`));
  const extension = createManifest(
    "interfaces",
    {
      ...parentState.snapshot,
      capabilities: applyCapabilityExtension(parentState.snapshot, {
        registrations: extensionInput.registrations,
        changes: extensionInput.changes,
      }),
      presentations,
    },
    parent,
  ) as RuntimeSupportManifest;
  assertInterfaceRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

export const extendStockTokenTradeHistoryRuntimeSupportManifest = (
  parent: RuntimeSupportManifest,
  extensionInput: RuntimeSupportManifestExtensionInput,
): RuntimeSupportManifest => {
  const parentState = manifestState(parent);
  const extension = createManifest("stock_token_trade_history", {
    ...parentState.snapshot,
    capabilities: applyCapabilityExtension(parentState.snapshot, extensionInput),
  }, parent) as RuntimeSupportManifest;
  assertStockTokenTradeHistoryRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

export const extendStockTokenPriceRuntimeSupportManifest = (
  parent: RuntimeSupportManifest,
  extensionInput: RuntimeSupportManifestExtensionInput,
): RuntimeSupportManifest => {
  const parentState = manifestState(parent);
  const extension = createManifest("stock_token_prices", {
    ...parentState.snapshot, capabilities: applyCapabilityExtension(parentState.snapshot, extensionInput),
  }, parent) as RuntimeSupportManifest;
  assertStockTokenPriceRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

export const extendTokenCatalogRuntimeSupportManifest = (
  parent: RuntimeSupportManifest,
  extensionInput: RuntimeSupportManifestExtensionInput,
): RuntimeSupportManifest => {
  const parentState = manifestState(parent);
  const extension = createManifest("token_catalog", {
    ...parentState.snapshot,
    capabilities: applyCapabilityExtension(parentState.snapshot, extensionInput),
  }, parent) as RuntimeSupportManifest;
  assertTokenCatalogRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

export const extendAccountAssetRuntimeSupportManifest = (
  parent: RuntimeSupportManifest,
  extensionInput: RuntimeSupportManifestExtensionInput,
): RuntimeSupportManifest => {
  const parentState = manifestState(parent);
  const extension = createManifest("account_assets", {
    ...parentState.snapshot,
    capabilities: applyCapabilityExtension(parentState.snapshot, extensionInput),
  }, parent) as RuntimeSupportManifest;
  assertAccountAssetRuntimeSupportManifestExtension(parent, extension);
  return extension;
};

const currentSupportMarker = "<!-- Generated from the runtime support manifest. Do not edit this section. -->";

export const mergeRuntimeSupportManifests = (
  base: RuntimeSupportManifest,
  parts: readonly RuntimeSupportManifest[],
): RuntimeSupportManifest => {
  const foundation = manifestState(base);
  if (foundation.scope !== "initial") throw new TypeError("Support composition requires the initial manifest.");
  const capabilities = new Map(foundation.snapshot.capabilities.map(entry => [entry.capabilityId, entry]));
  const original = new Map(capabilities);
  const claimed = new Set<string>();
  const protocols = new Map(foundation.snapshot.protocols.map(entry => [entry.protocolId, entry]));
  const actions = [...foundation.snapshot.transactionActions];
  const scopes = new Set<ManifestScope>();
  for (const part of parts) {
    const state = manifestState(part);
    if (state.parent !== base || scopes.has(state.scope) ||
        canonicalJsonStringify(captureCanonicalJson(state.snapshot.chains)) !==
          canonicalJsonStringify(captureCanonicalJson(foundation.snapshot.chains))) {
      throw new TypeError("Independent support composition provenance is invalid.");
    }
    scopes.add(state.scope);
    for (const entry of state.snapshot.capabilities) {
      const previous = original.get(entry.capabilityId);
      if (previous !== undefined && canonicalJsonStringify(captureCanonicalJson(previous)) ===
          canonicalJsonStringify(captureCanonicalJson(entry))) continue;
      if (claimed.has(entry.capabilityId)) throw new TypeError("Capability support has multiple producers.");
      claimed.add(entry.capabilityId);
      capabilities.set(entry.capabilityId, entry);
    }
    for (const entry of state.snapshot.protocols) {
      if (protocols.has(entry.protocolId)) throw new TypeError("Protocol support has multiple producers.");
      protocols.set(entry.protocolId, entry);
    }
    actions.push(...state.snapshot.transactionActions);
  }
  return createManifest("composition", { ...foundation.snapshot,
    capabilities: [...capabilities.values()].sort((a,b) => compareCodePointSequences(a.capabilityId,b.capabilityId)),
    protocols: [...protocols.values()].sort((a,b) => compareCodePointSequences(a.protocolId,b.protocolId)),
    transactionActions: actions });
};

export const renderCurrentSupportSection = (manifest: RuntimeSupportManifest): string => {
  const snapshot = readRuntimeSupportManifest(manifest);
  const chain = snapshot.chains[0];
  if (chain === undefined) throw new TypeError("Robinhood Chain support is unavailable.");
  const availableCapabilities = snapshot.capabilities
    .filter((entry) => entry.availability.overall === availableAvailability)
    .map((entry) => `\`${entry.capabilityId}\``);
  const walletConnectionAvailability = snapshot.capabilities
    .find((entry) => entry.capabilityId === walletConnectionCapabilityId)?.availability;
  const walletCapabilities = snapshot.capabilities
    .filter((entry) => entry.capabilityId.startsWith("wallet."));
  const exposedBindingLabels = (availability: CapabilityAvailability): readonly string[] => Object.freeze([
    availability.http === availableAvailability ? "HTTP" : undefined,
    availability.mcp === availableAvailability ? "MCP" : undefined,
    availability.cli === availableAvailability ? "CLI" : undefined,
  ].filter((value): value is string => value !== undefined));
  const walletSupport = walletCapabilities
    .filter((entry) => entry.availability.overall === availableAvailability)
    .map((entry) => `\`${entry.capabilityId}\` (${exposedBindingLabels(entry.availability).join(", ")})`);
  const displayLevel = (level: string): string => level.replace("_", " ");
  const protocols = snapshot.protocols.flatMap((entry) => {
    const evidence = entry.identityEvidence;
    const identifiers = (values: readonly string[]): string =>
      values.map((value) => `\`${value}\``).join(", ");
    const revision = evidence.sourceRevision === undefined
      ? ""
      : ` Revision: \`${evidence.sourceRevision}\`.`;
    return [
      `- Implemented protocol support: \`${entry.protocolId}\` (${displayLevel(entry.supportLevel)}).`,
      `  Official identity source: [${evidence.sourceOwner}](${evidence.reference.uri}) (\`${evidence.sourceClass}\`).${revision}`,
      `  Coverage: \`${evidence.coverage}\`.`,
      `  Supported conclusions: ${identifiers(evidence.supportedConclusions)}.`,
      `  Unsupported conclusions: ${identifiers(evidence.unsupportedConclusions)}.`,
      `  Exclusions: ${identifiers(evidence.exclusions)}.`,
    ];
  });
  const presentations = snapshot.presentations.map((entry) =>
    `\`${entry.contractId}@${entry.contractVersion}\``);
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
    ...(protocols.length === 0 ? ["- Implemented protocol support: none."] : protocols),
    walletSupport.length === 0
      ? "- Implemented wallet support: none."
      : `- Implemented wallet support: ${walletSupport.join("; ")}.`,
    snapshot.transactionActions.length === 0 ? "- Implemented transaction actions: none." :
      `- Implemented transaction actions: ${snapshot.transactionActions.map((entry) => `\`${entry.actionId}@${entry.contractVersion}\` on \`${entry.protocolId}\` (${entry.supportLevel.replace("_", " ")})`).join("; ")}.`,
    presentations.length === 0
      ? "- Implemented MCP App presentation contracts: none."
      : `- Implemented MCP App presentation contracts: ${presentations.join(", ")}.`,
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

export type CapabilityCatalogEntry = CapabilitySchemaProjection & Readonly<{
  availability: CapabilityAvailabilityInput;
}>;

export interface CapabilityCatalog {
  readonly contractVersion: "1";
  readonly capabilities: readonly CapabilityCatalogEntry[];
}

const capabilityRegistryProjections = (
  registry: CapabilityRegistry,
): readonly CapabilitySchemaProjection[] => projectCapabilities(registry);

const createCapabilityCatalogSchemaSet = (
  registry: CapabilityRegistry,
  contractVersion: "1",
) => {
  const expectedProjections = capabilityRegistryProjections(registry);
  const expectedProjectionJson = expectedProjections.map((projection) =>
    canonicalJsonStringify(projection as unknown as CanonicalJson));
  const createSchema = (availability: typeof publicSchemas.capabilityAvailability) => {
    const entry = extendCapabilitySchemaProjection({ availability });
    return z.object({
      contractVersion: z.literal(contractVersion),
      capabilities: z.array(entry).length(expectedProjections.length),
    }).strict().superRefine((value, context) => {
      for (let index = 0; index < expectedProjections.length; index += 1) {
        const expected = expectedProjections[index];
        const actual = value.capabilities[index];
        if (expected === undefined || actual === undefined) continue;
        if (actual.capabilityId !== expected.capabilityId) {
          context.addIssue({
            code: "custom",
            path: ["capabilities", index, "capabilityId"],
            message: "Capability catalog identities must match the supplied registry in canonical order.",
          });
          continue;
        }
        const { availability: _availability, ...actualProjection } = actual;
        if (
          canonicalJsonStringify(actualProjection as unknown as CanonicalJson) !==
          expectedProjectionJson[index]
        ) {
          context.addIssue({
            code: "custom",
            path: ["capabilities", index],
            message: "Capability catalog projection does not match the supplied registry.",
          });
        }
      }
    });
  };
  return Object.freeze({
    expectedProjections,
    publicSchema: createSchema(publicSchemas.capabilityAvailability),
    authoritySchema: createSchema(authoritySchemas.capabilityAvailability),
  });
};

export const createCapabilityCatalogSchema = (
  registry: CapabilityRegistry,
  contractVersion: "1",
): z.ZodType<CapabilityCatalog> => guardRuntimeJsonSchema(
  createCapabilityCatalogSchemaSet(registry, contractVersion).publicSchema,
) as z.ZodType<CapabilityCatalog>;

export const composeCapabilityCatalog = (
  registry: CapabilityRegistry,
  manifest: RuntimeSupportManifest,
  contractVersion: "1",
): CapabilityCatalog => {
  const catalogSchemas = createCapabilityCatalogSchemaSet(registry, contractVersion);
  const snapshot = readRuntimeSupportManifest(manifest);
  const availability = new Map<string, RuntimeSupportManifestSnapshot["capabilities"][number]["availability"]>(
    snapshot.capabilities.map((entry) => [entry.capabilityId, entry.availability]),
  );
  const capabilities = catalogSchemas.expectedProjections.map((projection) => {
    const state = availability.get(projection.capabilityId);
    if (state === undefined) throw new TypeError("Registered capability has no support entry.");
    return { ...projection, availability: state };
  });
  const catalog = parseRuntimeAuthority(catalogSchemas.authoritySchema, {
    contractVersion,
    capabilities,
  });
  canonicalJsonStringify(catalog as unknown as CanonicalJson);
  return Object.freeze({
    ...catalog,
    capabilities: Object.freeze(catalog.capabilities),
  }) as unknown as CapabilityCatalog;
};
