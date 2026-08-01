import { describe, expect, it } from "vitest";

import { parseEvmAddressInput } from "../../src/core/browser.js";
import {
  protocolFamilyDescriptorSchema,
  protocolPackageDescriptorSchema,
  ProtocolRegistry,
  type ProtocolFamilyDescriptor,
  type ProtocolPackageDescriptor,
} from "../../src/protocols/browser.js";
import {
  createProtocolRegistrySupportExtension,
  readProtocolSupportExtension,
} from "../../src/protocols/application.js";
import {
  uniswapProtocolFamily,
  uniswapV2DeploymentSource,
  uniswapV2DeploymentSourceId,
  uniswapV2PackageDescriptor,
  uniswapV2QuoteCapabilityId,
} from "../../src/protocols/uniswap-v2/browser.js";

const family = (
  familyId: string,
  displayName: string,
): ProtocolFamilyDescriptor => protocolFamilyDescriptorSchema.parse({
  familyId,
  displayName,
});

const packageDescriptor = (
  protocolId: string,
  familyId: string,
  address: string,
): ProtocolPackageDescriptor => protocolPackageDescriptorSchema.parse({
  protocolId,
  familyId,
  versionDisplayName: protocolId.endsWith("_v2") ? "V2" : "V1",
  packageContractVersion: "1",
  supportLevel: "L0_discovered",
  identityEvidence: {
    sourceOwner: "Example Protocol",
    sourceClass: "official_document",
    reference: {
      kind: "public",
      sourceId: `${protocolId}_deployment`,
      uri: `https://example.com/${protocolId}`,
    },
    sourceRevision: "1.0.0",
    coverage: `Exact ${protocolId} test deployment identity.`,
    exclusions: ["Runtime state."],
    supportedConclusions: ["Deployment identity."],
    unsupportedConclusions: ["Runtime availability.", "Safety."],
  },
  sdkDependencies: [{
    packageName: `@example/${protocolId.replaceAll("_", "-")}-sdk`,
    version: "1.0.0",
  }],
  deployments: [{
    protocolId,
    chainId: "eip155:4663",
    contractRole: "factory",
    address,
  }],
  capabilities: [{
    capabilityId: `${protocolId}.quote_exact_input`,
  }],
});

const internalAvailability = Object.freeze({
  overall: "internal" as const,
  direct: "internal" as const,
  http: "unavailable" as const,
  mcp: "unavailable" as const,
  cli: "unavailable" as const,
  web: "unavailable" as const,
});

describe("protocol registration contracts", () => {
  it("registers the V2 package without adding dispatch behavior to its family", () => {
    const registry = new ProtocolRegistry(
      [uniswapProtocolFamily],
      [uniswapV2PackageDescriptor],
    );
    expect(registry.getFamily("uniswap")).toEqual({
      familyId: "uniswap",
      displayName: "Uniswap",
    });
    expect(registry.getPackage("uniswap_v2")).toEqual(uniswapV2PackageDescriptor);
    expect(uniswapV2PackageDescriptor.identityEvidence).toEqual({
      sourceOwner: uniswapV2DeploymentSource.sourceOwner,
      sourceClass: uniswapV2DeploymentSource.sourceClass,
      reference: {
        kind: "public",
        sourceId: uniswapV2DeploymentSourceId,
        uri: uniswapV2DeploymentSource.sourceUri,
      },
      sourceRevision: uniswapV2DeploymentSource.sourceRevision,
      coverage: uniswapV2DeploymentSource.coverage,
      exclusions: uniswapV2DeploymentSource.exclusions,
      supportedConclusions: uniswapV2DeploymentSource.supportedConclusions,
      unsupportedConclusions: uniswapV2DeploymentSource.unsupportedConclusions,
    });
    expect(registry.ownsCapability(
      "uniswap_v2",
      uniswapV2QuoteCapabilityId,
    )).toBe(true);
  });

  it("admits only the current protocol package contract structure", () => {
    const descriptor = packageDescriptor(
      "example_v1",
      "example",
      `0x${"11".repeat(20)}`,
    );
    expect(descriptor.packageContractVersion).toBe("1");
    for (const packageContractVersion of ["0", "2", "10"]) {
      expect(() => protocolPackageDescriptorSchema.parse({
        ...descriptor,
        packageContractVersion,
      }), packageContractVersion).toThrow();
    }
  });

  it("admits future protocol identities without a shared current-version enum", () => {
    const descriptor = packageDescriptor(
      "future_protocol_v7",
      "future_protocol",
      `0x${"11".repeat(20)}`,
    );
    expect(descriptor.protocolId).toBe("future_protocol_v7");
    expect(protocolPackageDescriptorSchema.parse({
      ...descriptor,
      sdkDependencies: [],
    }).sdkDependencies).toEqual([]);
    expect(protocolFamilyDescriptorSchema.parse({
      familyId: "modern_swap",
      displayName: "LatestSwap",
    }).displayName).toBe("LatestSwap");
  });

  it("admits only exact semantic SDK versions", () => {
    const descriptor = packageDescriptor(
      "future_protocol_v7",
      "future_protocol",
      `0x${"11".repeat(20)}`,
    );
    expect(protocolPackageDescriptorSchema.parse({
      ...descriptor,
      sdkDependencies: [{
        ...descriptor.sdkDependencies[0],
        version: "1.2.3-alpha.1+build.7",
      }],
    }).sdkDependencies[0]?.version).toBe("1.2.3-alpha.1+build.7");
    for (const version of [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-",
      "1.2.3-01",
      "1.2.3-alpha..1",
      "1.2.3+",
      "1.2.3+build..1",
      "^1.2.3",
    ]) {
      expect(() => protocolPackageDescriptorSchema.parse({
        ...descriptor,
        sdkDependencies: [{
          ...descriptor.sdkDependencies[0],
          version,
        }],
      }), version).toThrow();
    }
  });

  it("keeps family display identity separate from two additive version packages", () => {
    const families = [family("example", "Example")];
    const first = packageDescriptor("example_v1", "example", `0x${"11".repeat(20)}`);
    const second = packageDescriptor("example_v2", "example", `0x${"22".repeat(20)}`);
    const firstRegistry = new ProtocolRegistry(families, [first]);
    const combinedRegistry = new ProtocolRegistry(families, [first, second]);
    expect(combinedRegistry.getFamily("example")).toEqual({ familyId: "example", displayName: "Example" });
    expect(combinedRegistry.getPackage("example_v1")).toEqual(firstRegistry.getPackage("example_v1"));
    expect("displayName" in combinedRegistry.getPackage("example_v1")).toBe(false);
    expect(new ProtocolRegistry(families, [first]).getPackage("example_v1")).toEqual(first);
  });

  it("rejects absent families, duplicates, unordered entries, latest aliases, and default deployment fields", () => {
    const first = packageDescriptor("example_v1", "example", `0x${"11".repeat(20)}`);
    expect(() => new ProtocolRegistry([], [first])).toThrow(TypeError);
    expect(() => new ProtocolRegistry(
      [family("example", "Example"), family("example", "Example")],
      [first],
    )).toThrow(TypeError);
    expect(() => new ProtocolRegistry(
      [family("example", "Example")],
      [
        packageDescriptor("example_v2", "example", `0x${"22".repeat(20)}`),
        first,
      ],
    )).toThrow(TypeError);
    expect(() => protocolPackageDescriptorSchema.parse({
      ...first,
      protocolId: "example_latest",
    })).toThrow();
    expect(() => protocolPackageDescriptorSchema.parse({
      ...first,
      versionDisplayName: "latest",
    })).toThrow();
    expect(() => protocolPackageDescriptorSchema.parse({
      ...first,
      defaultDeployment: first.deployments[0],
    })).toThrow();
    expect(() => protocolPackageDescriptorSchema.parse({
      ...first,
      sdkDependencies: [
        first.sdkDependencies[0],
        { ...first.sdkDependencies[0], version: "2.0.0" },
      ],
    })).toThrow();
    const { identityEvidence: _identityEvidence, ...withoutIdentityEvidence } = first;
    expect(() => protocolPackageDescriptorSchema.parse(withoutIdentityEvidence)).toThrow();
    expect(() => protocolPackageDescriptorSchema.parse({
      ...first,
      identityEvidence: {
        ...first.identityEvidence,
        unsupportedConclusions: [],
      },
    })).toThrow();
  });

  it("keeps deployments independently addressable and has no fallback lookup", () => {
    const first = packageDescriptor("example_v1", "example", `0x${"11".repeat(20)}`);
    const second = protocolPackageDescriptorSchema.parse({
      ...first,
      deployments: [
        first.deployments[0],
        {
          ...first.deployments[0],
          address: `0x${"22".repeat(20)}`,
        },
      ],
    });
    const registry = new ProtocolRegistry([family("example", "Example")], [second]);
    expect(registry.getDeployment(second.deployments[0]!)).toEqual(second.deployments[0]);
    expect(registry.getDeployment(second.deployments[1]!)).toEqual(second.deployments[1]);
    expect(() => registry.getDeployment({
      ...second.deployments[0]!,
      address: parseEvmAddressInput(`0x${"33".repeat(20)}`),
    })).toThrow(TypeError);
  });

  it("projects exact registered protocol and capability support in canonical order", () => {
    const first = packageDescriptor("example_v1", "example", `0x${"11".repeat(20)}`);
    const second = protocolPackageDescriptorSchema.parse({
      ...packageDescriptor("example_v2", "example", `0x${"22".repeat(20)}`),
      supportLevel: "L1_analyzed",
    });
    const registry = new ProtocolRegistry([family("example", "Example")], [first, second]);
    const projected = readProtocolSupportExtension(
      createProtocolRegistrySupportExtension(registry, {
      capabilities: [
        { capabilityId: "example_v1.quote_exact_input", availability: internalAvailability },
        { capabilityId: "example_v2.quote_exact_input", availability: internalAvailability },
      ],
    }));
    expect(projected.protocols).toEqual([
      {
        protocolId: "example_v1",
        supportLevel: "L0_discovered",
        identityEvidence: first.identityEvidence,
      },
      {
        protocolId: "example_v2",
        supportLevel: "L1_analyzed",
        identityEvidence: second.identityEvidence,
      },
    ]);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.protocols)).toBe(true);
    expect(Object.isFrozen(projected.protocols[0]?.identityEvidence)).toBe(true);
    expect(Object.isFrozen(projected.protocols[0]?.identityEvidence.reference)).toBe(true);
    expect(Object.isFrozen(projected.registrations[0]?.availability)).toBe(true);
    expect(() => readProtocolSupportExtension({} as never)).toThrow(
      "Protocol support extension provenance is invalid.",
    );
    expect(() => createProtocolRegistrySupportExtension(registry, {
      capabilities: [
        { capabilityId: "example_v2.quote_exact_input", availability: internalAvailability },
        { capabilityId: "example_v1.quote_exact_input", availability: internalAvailability },
      ],
    })).toThrow(TypeError);
  });
});
