import { z } from "zod";

import {
  capabilityIdSchema,
  compareCodePointSequences,
  deepFreezeValue,
  evmAddressSchema,
  evmChainIdSchema,
  generalSingleLineTextSchema,
  jsonObject,
  officialIdentityEvidenceSchema,
  snakeCaseCodeSchema,
  supportLevelSchema,
} from "../core/client.js";

const protocolIdentifierSchema = snakeCaseCodeSchema.refine(
  (value) => !value.split("_").includes("latest"),
  "Protocol identifiers cannot contain a latest-version alias.",
);

export const protocolFamilyIdSchema = protocolIdentifierSchema.brand("ProtocolFamilyId");
export type ProtocolFamilyId = z.infer<typeof protocolFamilyIdSchema>;

export const protocolIdSchema = protocolIdentifierSchema.brand("ProtocolId");
export type ProtocolId = z.infer<typeof protocolIdSchema>;

export const protocolPackageContractVersionSchema = z.literal("1")
  .brand("ProtocolPackageContractVersion");
export type ProtocolPackageContractVersion = z.infer<
  typeof protocolPackageContractVersionSchema
>;

const npmPackageNameSchema = z.string()
  .min(1)
  .max(214)
  .regex(
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u,
    "Expected an exact lowercase npm package name.",
  );

const semanticVersionCorePattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const semanticVersionIdentifierPattern = /^[0-9A-Za-z-]+$/u;
const canonicalNumericIdentifierPattern = /^(?:0|[1-9][0-9]*)$/u;

const isExactSemanticVersion = (value: string): boolean => {
  const plusParts = value.split("+");
  if (plusParts.length > 2) return false;
  const [versionAndPrerelease, build] = plusParts;
  if (versionAndPrerelease === undefined) return false;

  const dashIndex = versionAndPrerelease.indexOf("-");
  const core = dashIndex === -1
    ? versionAndPrerelease
    : versionAndPrerelease.slice(0, dashIndex);
  const prerelease = dashIndex === -1
    ? undefined
    : versionAndPrerelease.slice(dashIndex + 1);
  if (!semanticVersionCorePattern.test(core)) return false;

  if (prerelease !== undefined) {
    const identifiers = prerelease.split(".");
    if (
      identifiers.some((identifier) =>
        !semanticVersionIdentifierPattern.test(identifier) ||
        (/^[0-9]+$/u.test(identifier) &&
          !canonicalNumericIdentifierPattern.test(identifier)))
    ) return false;
  }

  return build === undefined ||
    build.split(".").every((identifier) =>
      semanticVersionIdentifierPattern.test(identifier));
};

const exactNpmPackageVersionSchema = z.string().refine(
  isExactSemanticVersion,
  "Expected an exact semantic package version without a range.",
);

export const protocolSdkDependencySchema = jsonObject({
  packageName: npmPackageNameSchema,
  version: exactNpmPackageVersionSchema,
}).strict();
export type ProtocolSdkDependency = z.infer<typeof protocolSdkDependencySchema>;

export const protocolFamilyDescriptorSchema = jsonObject({
  familyId: protocolFamilyIdSchema,
  displayName: generalSingleLineTextSchema,
}).strict().superRefine((value, context) => {
  if (value.displayName.toLowerCase() === "latest") {
    context.addIssue({
      code: "custom",
      message: "Protocol family names cannot be a latest-version alias.",
    });
  }
});
export type ProtocolFamilyDescriptor = z.infer<typeof protocolFamilyDescriptorSchema>;

export const protocolDeploymentIdentitySchema = jsonObject({
  protocolId: protocolIdSchema,
  chainId: evmChainIdSchema,
  contractRole: snakeCaseCodeSchema,
  address: evmAddressSchema,
}).strict();
export type ProtocolDeploymentIdentity = z.infer<typeof protocolDeploymentIdentitySchema>;

export const protocolDeploymentSelectionSchema = protocolDeploymentIdentitySchema;
export type ProtocolDeploymentSelection = ProtocolDeploymentIdentity;

export const protocolCapabilityDescriptorSchema = jsonObject({
  capabilityId: capabilityIdSchema,
}).strict();
export type ProtocolCapabilityDescriptor = z.infer<typeof protocolCapabilityDescriptorSchema>;

export const protocolPackageDescriptorSchema = jsonObject({
  protocolId: protocolIdSchema,
  familyId: protocolFamilyIdSchema,
  versionDisplayName: generalSingleLineTextSchema,
  packageContractVersion: protocolPackageContractVersionSchema,
  supportLevel: supportLevelSchema,
  identityEvidence: officialIdentityEvidenceSchema,
  sdkDependencies: z.array(protocolSdkDependencySchema),
  deployments: z.array(protocolDeploymentIdentitySchema).min(1),
  capabilities: z.array(protocolCapabilityDescriptorSchema).min(1),
}).strict().superRefine((value, context) => {
  if (value.versionDisplayName.toLowerCase() === "latest") {
    context.addIssue({
      code: "custom",
      message: "Protocol version names cannot be a latest-version alias.",
    });
  }
  const dependencyKeys = value.sdkDependencies.map((dependency) => dependency.packageName);
  const deploymentKeys = value.deployments.map(
    (deployment) =>
      `${deployment.protocolId}\0${deployment.chainId}\0${deployment.contractRole}\0${deployment.address}`,
  );
  const capabilityIds = value.capabilities.map((capability) => capability.capabilityId);
  for (const [label, values] of [
    ["SDK dependencies", dependencyKeys],
    ["deployments", deploymentKeys],
    ["capabilities", capabilityIds],
  ] as const) {
    const ordered = [...values].sort(compareCodePointSequences);
    if (
      new Set(values).size !== values.length ||
      values.join("\0") !== ordered.join("\0")
    ) {
      context.addIssue({
        code: "custom",
        message: `Protocol package ${label} must be unique and ordered.`,
      });
    }
  }
  if (value.deployments.some((deployment) => deployment.protocolId !== value.protocolId)) {
    context.addIssue({
      code: "custom",
      message: "Protocol deployment identities must belong to their package.",
    });
  }
  if (value.capabilities.some(
    (capability) => capability.capabilityId.split(".", 1)[0] !== value.protocolId,
  )) {
    context.addIssue({
      code: "custom",
      message: "Protocol capability identities must belong to their package.",
    });
  }
});
export type ProtocolPackageDescriptor = z.infer<typeof protocolPackageDescriptorSchema>;

export const admitProtocolFamilyDescriptor = (
  input: ProtocolFamilyDescriptor,
): ProtocolFamilyDescriptor =>
  deepFreezeValue(protocolFamilyDescriptorSchema.parse(input));

export const admitProtocolPackageDescriptor = (
  input: ProtocolPackageDescriptor,
): ProtocolPackageDescriptor =>
  deepFreezeValue(protocolPackageDescriptorSchema.parse(input));

export const protocolDeploymentIdentityKey = (
  input: ProtocolDeploymentIdentity,
): string => {
  const deployment = protocolDeploymentIdentitySchema.parse(input);
  return [
    deployment.protocolId,
    deployment.chainId,
    deployment.contractRole,
    deployment.address,
  ].join("\0");
};
