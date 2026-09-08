import {
  compareCodePointSequences,
  isStrictlyOrderedUnique,
  deepFreezeValue,
} from "../core/index.js";
import {
  type CapabilitySupportEntryInput,
  type ProtocolSupportEntryInput,
  type RuntimeProtocolSupportManifestExtensionInput,
} from "../runtime/support-manifest.js";
import type { ProtocolRegistry } from "./registry.js";

export interface ProtocolSupportProjectionInput {
  readonly capabilities: readonly CapabilitySupportEntryInput[];
}

declare const protocolSupportExtensionType: unique symbol;
export interface ProtocolSupportExtension {
  readonly [protocolSupportExtensionType]: true;
}

const protocolSupportExtensions =
  new WeakMap<object, RuntimeProtocolSupportManifestExtensionInput>();

const protocolSupportExtensionState = (
  extension: ProtocolSupportExtension,
): RuntimeProtocolSupportManifestExtensionInput => {
  const state = typeof extension === "object" && extension !== null
    ? protocolSupportExtensions.get(extension)
    : undefined;
  if (state === undefined) {
    throw new TypeError("Protocol support extension provenance is invalid.");
  }
  return state;
};

const assertExactOrderedIdentities = (
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void => {
  if (
    !isStrictlyOrderedUnique(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new TypeError(`${label} must exactly match the registered protocol packages.`);
  }
};

export const createProtocolRegistrySupportExtension = (
  registry: ProtocolRegistry,
  input: ProtocolSupportProjectionInput,
): ProtocolSupportExtension => {
  const packages = registry.packageValues();
  assertExactOrderedIdentities(
    input.capabilities.map((entry) => entry.capabilityId),
    packages.flatMap((entry) => entry.capabilities.map((capability) => capability.capabilityId))
      .sort(compareCodePointSequences),
    "Protocol capability support identities",
  );
  for (const entry of input.capabilities) {
    const protocolId = entry.capabilityId.split(".", 1)[0] ?? "";
    if (!registry.ownsCapability(protocolId, entry.capabilityId)) {
      throw new TypeError("Protocol capability support has no registered owner.");
    }
  }
  const state = deepFreezeValue({
    protocols: packages.map((entry): ProtocolSupportEntryInput => ({
      protocolId: entry.protocolId,
      supportLevel: entry.supportLevel,
      identityEvidence: entry.identityEvidence,
    })),
    registrations: input.capabilities.map((entry) => ({
      capabilityId: entry.capabilityId,
      availability: { ...entry.availability },
    })),
    changes: [],
  });
  const extension = Object.freeze({}) as ProtocolSupportExtension;
  protocolSupportExtensions.set(extension, state);
  return extension;
};

export const readProtocolSupportExtension = (
  extension: ProtocolSupportExtension,
): RuntimeProtocolSupportManifestExtensionInput =>
  protocolSupportExtensionState(extension);
