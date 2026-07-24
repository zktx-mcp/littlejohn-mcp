import { z } from "zod";

import {
  canonicalBase64UrlSchema,
  chainAnchorSchema,
  deepFreezeValue,
  evmAddressSchema,
  evmChainIdSchema,
  hash32Schema,
  jsonObject,
  parseEvmAddressInput,
  parseHash32,
  productChainId,
  productChainNumericId,
  tokenDisplayTextSchema,
  unsignedDecimalSchema,
  utcTimestampSchema,
} from "../core/browser.js";

const positiveSafeIntegerSchema = z.number().int().positive().safe();

const officialAssetSourceManifestSchema = jsonObject({
  sourceUri: z.string().url(),
  documentationSourceUri: z.string().url(),
  chainId: evmChainIdSchema,
  deploymentChainId: positiveSafeIntegerSchema,
  activeStatus: z.string().min(1),
  responseByteLimit: positiveSafeIntegerSchema,
  memberLimit: positiveSafeIntegerSchema,
  deploymentLimit: positiveSafeIntegerSchema,
  responseDeadlineMs: positiveSafeIntegerSchema,
}).strict().superRefine((value, context) => {
  if (
    value.chainId !== productChainId ||
    value.deploymentChainId !== productChainNumericId
  ) {
    context.addIssue({
      code: "custom",
      message: "Official asset source manifest chain is invalid.",
    });
  }
});

export const officialAssetSourceManifest = deepFreezeValue(
  officialAssetSourceManifestSchema.parse({
    sourceUri: "https://api.robinhood.com/rhj/assets",
    documentationSourceUri: "https://docs.robinhood.com/chain/contracts/",
    chainId: productChainId,
    deploymentChainId: productChainNumericId,
    activeStatus: "ASSET_STATUS_ACTIVE",
    responseByteLimit: 1_048_576,
    memberLimit: 512,
    deploymentLimit: 8,
    responseDeadlineMs: 10_000,
  }),
);

const stockFactoryAdmissionManifestSchema = jsonObject({
  chainId: evmChainIdSchema,
  proxyAddress: evmAddressSchema,
  implementationAddress: evmAddressSchema,
  implementationSlot: hash32Schema,
  proxyCodeHash: hash32Schema,
  implementationCodeHash: hash32Schema,
  observedOn: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u),
  observationBlockNumber: unsignedDecimalSchema,
  observationBlockHash: hash32Schema,
  proxySourceUri: z.string().url(),
  implementationSourceUri: z.string().url(),
}).strict().superRefine((value, context) => {
  if (value.chainId !== productChainId) {
    context.addIssue({
      code: "custom",
      message: "StockFactory admission manifest chain is invalid.",
    });
  }
});

export const stockFactoryAdmissionManifest = deepFreezeValue(
  stockFactoryAdmissionManifestSchema.parse({
    chainId: productChainId,
    proxyAddress: parseEvmAddressInput(
      "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046",
    ),
    implementationAddress: parseEvmAddressInput(
      "0xEe351E53BCe6AAF106428358838197C91e36EE0E",
    ),
    implementationSlot: parseHash32(
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    ),
    proxyCodeHash: parseHash32(
      "0x394c3517e9331e7c88ef8af388c0cb63c720af1b1b4d5a5cace212f7df0b045a",
    ),
    implementationCodeHash: parseHash32(
      "0x3bfd5841605b9931c9dbb0f9f54a28b4038918ceb74d6d1081bc7f963fe528b4",
    ),
    observedOn: "2026-07-20",
    observationBlockNumber: unsignedDecimalSchema.parse("14660943"),
    observationBlockHash: parseHash32(
      "0x94d90a8691fc4fc7a4fb48a86755f948f2a1110325d6c8257dbfeaddaf8832b0",
    ),
    proxySourceUri:
      "https://robinhoodchain.blockscout.com/address/0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046",
    implementationSourceUri:
      "https://robinhoodchain.blockscout.com/address/0xEe351E53BCe6AAF106428358838197C91e36EE0E",
  }),
);

export const officialAssetSourceLabelSchema = tokenDisplayTextSchema
  .refine((value) => value.length > 0, "Official source labels cannot be empty.");

export const officialAssetSourceMemberSchema = jsonObject({
  assetUid: hash32Schema,
  contractAddress: evmAddressSchema,
  sourceName: officialAssetSourceLabelSchema.optional(),
  sourceSymbol: officialAssetSourceLabelSchema.optional(),
}).strict();
export type OfficialAssetSourceMember = z.infer<typeof officialAssetSourceMemberSchema>;

export const officialAssetCandidateSchema = jsonObject({
  assetUid: hash32Schema,
  contractAddress: evmAddressSchema,
  sourceName: officialAssetSourceLabelSchema.nullable(),
  sourceSymbol: officialAssetSourceLabelSchema.nullable(),
}).strict();
export type OfficialAssetCandidate = z.infer<typeof officialAssetCandidateSchema>;

const officialAssetSourceSnapshotShape = {
  sourceUri: z.string().url(),
  sourceObservedAt: utcTimestampSchema,
  rawResponseDigest: hash32Schema,
  memberSetDigest: hash32Schema,
  candidateListDigest: hash32Schema,
  chainId: evmChainIdSchema,
  members: z.array(officialAssetSourceMemberSchema)
    .min(1)
    .max(officialAssetSourceManifest.memberLimit),
} as const;

export const officialAssetSourceSnapshotSchema = jsonObject(
  officialAssetSourceSnapshotShape,
).strict().superRefine((value, context) => {
  if (
    value.sourceUri !== officialAssetSourceManifest.sourceUri ||
    value.chainId !== officialAssetSourceManifest.chainId
  ) {
    context.addIssue({
      code: "custom",
      message: "Official asset snapshot authority is invalid.",
    });
  }
});
export type OfficialAssetSourceSnapshot = z.infer<typeof officialAssetSourceSnapshotSchema>;

export const officialAssetSnapshotRevisionSchema = canonicalBase64UrlSchema(16)
  .brand("OfficialAssetSnapshotRevision");
export type OfficialAssetSnapshotRevision = z.infer<
  typeof officialAssetSnapshotRevisionSchema
>;

export const committedOfficialAssetSnapshotSchema = jsonObject({
  ...officialAssetSourceSnapshotShape,
  revision: officialAssetSnapshotRevisionSchema,
  updatedAt: utcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (
    value.sourceUri !== officialAssetSourceManifest.sourceUri ||
    value.chainId !== officialAssetSourceManifest.chainId
  ) {
    context.addIssue({
      code: "custom",
      message: "Committed official asset snapshot authority is invalid.",
    });
  }
});
export type CommittedOfficialAssetSnapshot = z.infer<
  typeof committedOfficialAssetSnapshotSchema
>;

export const officialAssetSnapshotEvidenceSchema = jsonObject({
  sourceUri: z.string().url(),
  sourceObservedAt: utcTimestampSchema,
  rawResponseDigest: hash32Schema,
  memberSetDigest: hash32Schema,
  revision: officialAssetSnapshotRevisionSchema,
}).strict().superRefine((value, context) => {
  if (value.sourceUri !== officialAssetSourceManifest.sourceUri) {
    context.addIssue({
      code: "custom",
      message: "Official asset evidence source is invalid.",
    });
  }
});
export type OfficialAssetSnapshotEvidence = z.infer<
  typeof officialAssetSnapshotEvidenceSchema
>;

export const stockFactoryVerificationFailureDefinitions = deepFreezeValue([
  { code: "factory_identity_mismatch", classificationReason: true },
  { code: "request_aborted", classificationReason: false },
  { code: "source_inconsistent", classificationReason: true },
  { code: "source_unavailable", classificationReason: true },
  { code: "token_code_missing", classificationReason: true },
  { code: "token_identity_mismatch", classificationReason: true },
] as const);

export type StockFactoryVerificationErrorCode =
  (typeof stockFactoryVerificationFailureDefinitions)[number]["code"];

const stockFactoryVerificationErrorCodeValues = Object.freeze(
  stockFactoryVerificationFailureDefinitions.map((definition) => definition.code),
) as readonly [
  StockFactoryVerificationErrorCode,
  ...StockFactoryVerificationErrorCode[],
];

export const stockFactoryVerificationErrorCodeSchema =
  z.enum(stockFactoryVerificationErrorCodeValues);

type StockFactoryClassificationFailureDefinition =
  (typeof stockFactoryVerificationFailureDefinitions)[number] extends infer Definition
    ? Definition extends { readonly classificationReason: true }
      ? Definition
      : never
    : never;

export type StockFactoryClassificationUnavailableReason =
  StockFactoryClassificationFailureDefinition["code"];

export const stockFactoryClassificationUnavailableReasons = Object.freeze(
  stockFactoryVerificationFailureDefinitions
    .filter((definition) => definition.classificationReason)
    .map((definition) => definition.code),
) as readonly [
  StockFactoryClassificationUnavailableReason,
  ...StockFactoryClassificationUnavailableReason[],
];

export const stockFactoryClassificationUnavailableReasonSchema =
  z.enum(stockFactoryClassificationUnavailableReasons);

export const stockFactoryVerificationSchema = jsonObject({
  assetUid: hash32Schema,
  contractAddress: evmAddressSchema,
  block: chainAnchorSchema,
  proxyAddress: evmAddressSchema,
  proxyCodeHash: hash32Schema,
  implementationAddress: evmAddressSchema,
  implementationCodeHash: hash32Schema,
  tokenCodeHash: hash32Schema,
}).strict().superRefine((value, context) => {
  if (
    value.block.chainId !== stockFactoryAdmissionManifest.chainId ||
    value.proxyAddress !== stockFactoryAdmissionManifest.proxyAddress ||
    value.proxyCodeHash !== stockFactoryAdmissionManifest.proxyCodeHash ||
    value.implementationAddress !== stockFactoryAdmissionManifest.implementationAddress ||
    value.implementationCodeHash !== stockFactoryAdmissionManifest.implementationCodeHash
  ) {
    context.addIssue({
      code: "custom",
      message: "StockFactory verification authority is invalid.",
    });
  }
});
export type StockFactoryVerification = z.infer<typeof stockFactoryVerificationSchema>;
