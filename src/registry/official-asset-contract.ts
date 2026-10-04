import { z } from "zod";

import {canonicalSha256, canonicalBase64UrlSchema, compareCodePointSequences, deepFreezeValue, hash32Schema, jsonObject, parseHash32, tokenDisplayTextSchema, unsignedDecimalSchema, utcTimestampSchema} from "../core/client.js";
import {chainAnchorSchema} from "../evm/primitives.js";
import {evmAddressSchema, evmChainIdSchema, type EvmAddress} from "../evm/identities.js";
import {parseEvmAddressInput} from "../evm/address-input.js";
import {productChainId} from "./product-identity.js";

const positiveSafeIntegerSchema = z.number().int().positive().safe();

const officialAssetSourceDefinitionSchema = jsonObject({
  sourceOwner: z.literal("Robinhood"),
  sourceId: z.literal("robinhood-official-assets"),
  sourceUri: z.string().url(),
  documentationSourceUri: z.string().url(),
  chainId: evmChainIdSchema,
  memberLimit: positiveSafeIntegerSchema,
}).strict().superRefine((value, context) => {
  if (value.chainId !== productChainId) {
    context.addIssue({
      code: "custom",
      message: "Official asset source definition chain is invalid.",
    });
  }
});

export const officialAssetSourceDefinition = deepFreezeValue(
  officialAssetSourceDefinitionSchema.parse({
    sourceOwner: "Robinhood",
    sourceId: "robinhood-official-assets",
    sourceUri: "https://api.robinhood.com/rhj/assets",
    documentationSourceUri: "https://docs.robinhood.com/chain/contracts/",
    chainId: productChainId,
    memberLimit: 512,
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
    .max(officialAssetSourceDefinition.memberLimit),
} as const;

export const officialAssetSourceSnapshotSchema = jsonObject(
  officialAssetSourceSnapshotShape,
).strict().superRefine((value, context) => {
  if (
    value.sourceUri !== officialAssetSourceDefinition.sourceUri ||
    value.chainId !== officialAssetSourceDefinition.chainId
  ) {
    context.addIssue({
      code: "custom",
      message: "Official asset snapshot authority is invalid.",
    });
  }
});
export type OfficialAssetSourceSnapshot = z.infer<typeof officialAssetSourceSnapshotSchema>;

export const officialAssetSnapshotRevisionByteLength = 16 as const;

export const officialAssetSnapshotRevisionSchema = canonicalBase64UrlSchema(
  officialAssetSnapshotRevisionByteLength,
)
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
    value.sourceUri !== officialAssetSourceDefinition.sourceUri ||
    value.chainId !== officialAssetSourceDefinition.chainId
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

const compareOfficialAssetSourceMembers = (
  left: OfficialAssetSourceMember,
  right: OfficialAssetSourceMember,
): number => compareCodePointSequences(left.assetUid, right.assetUid) ||
  compareCodePointSequences(left.contractAddress, right.contractAddress);

export const assertOfficialAssetSourceMember = (
  input: OfficialAssetSourceMember,
): OfficialAssetSourceMember =>
  deepFreezeValue(officialAssetSourceMemberSchema.parse(input));

const memberSetPayload = (
  members: readonly OfficialAssetSourceMember[],
) => ({
  version: "1",
  chainId: officialAssetSourceDefinition.chainId,
  sourceUri: officialAssetSourceDefinition.sourceUri,
  members: members.map((member) => ({
    assetUid: member.assetUid,
    contractAddress: member.contractAddress,
  })),
}) as const;

const candidateListPayload = (
  members: readonly OfficialAssetSourceMember[],
) => ({
  version: "1",
  chainId: officialAssetSourceDefinition.chainId,
  sourceUri: officialAssetSourceDefinition.sourceUri,
  members: members.map((member) => ({
    assetUid: member.assetUid,
    contractAddress: member.contractAddress,
    sourceName: member.sourceName ?? null,
    sourceSymbol: member.sourceSymbol ?? null,
  })),
}) as const;

export const officialAssetMemberSetDigest = (
  members: readonly OfficialAssetSourceMember[],
) => parseHash32(`0x${canonicalSha256(memberSetPayload(members))}`);

export const officialAssetCandidateListDigest = (
  members: readonly OfficialAssetSourceMember[],
) => parseHash32(`0x${canonicalSha256(candidateListPayload(members))}`);

export const assertOfficialAssetSourceSnapshot = (
  input: OfficialAssetSourceSnapshot,
): OfficialAssetSourceSnapshot => {
  const parsed = officialAssetSourceSnapshotSchema.parse(input);
  const members = parsed.members.map(assertOfficialAssetSourceMember);
  for (let index = 0; index < members.length; index += 1) {
    const original = parsed.members[index] as OfficialAssetSourceMember;
    const member = members[index] as OfficialAssetSourceMember;
    if (
      compareOfficialAssetSourceMembers(original, member) !== 0 ||
      (
        index > 0 &&
        compareOfficialAssetSourceMembers(
          members[index - 1] as OfficialAssetSourceMember,
          member,
        ) >= 0
      )
    ) {
      throw new TypeError("Official asset snapshot members are not in canonical order.");
    }
  }
  const addresses = new Set(members.map((member) => member.contractAddress));
  const uids = new Set(members.map((member) => member.assetUid));
  if (addresses.size !== members.length || uids.size !== members.length) {
    throw new TypeError("Official asset snapshot contains a duplicate identity.");
  }
  const memberSetDigest = parsed.memberSetDigest;
  const candidateListDigest = parsed.candidateListDigest;
  if (
    memberSetDigest !== officialAssetMemberSetDigest(members) ||
    candidateListDigest !== officialAssetCandidateListDigest(members)
  ) {
    throw new TypeError("Official asset snapshot digests are invalid.");
  }
  return deepFreezeValue(officialAssetSourceSnapshotSchema.parse({
    sourceUri: officialAssetSourceDefinition.sourceUri,
    sourceObservedAt: parsed.sourceObservedAt,
    rawResponseDigest: parsed.rawResponseDigest,
    memberSetDigest,
    candidateListDigest,
    chainId: officialAssetSourceDefinition.chainId,
    members,
  }));
};

export const assertCommittedOfficialAssetSnapshot = (
  input: CommittedOfficialAssetSnapshot,
): CommittedOfficialAssetSnapshot => {
  const parsed = committedOfficialAssetSnapshotSchema.parse(input);
  const snapshot = assertOfficialAssetSourceSnapshot({
    sourceUri: parsed.sourceUri,
    sourceObservedAt: parsed.sourceObservedAt,
    rawResponseDigest: parsed.rawResponseDigest,
    memberSetDigest: parsed.memberSetDigest,
    candidateListDigest: parsed.candidateListDigest,
    chainId: parsed.chainId,
    members: parsed.members,
  });
  return deepFreezeValue({
    ...snapshot,
    revision: parsed.revision,
    updatedAt: parsed.updatedAt,
  });
};

export const findOfficialAssetMember = (
  snapshot: OfficialAssetSourceSnapshot,
  contractAddress: EvmAddress,
): OfficialAssetSourceMember | undefined => snapshot.members.find(
  (member) => member.contractAddress === contractAddress,
);

export const officialAssetSnapshotEvidenceSchema = jsonObject({
  sourceUri: z.string().url(),
  sourceObservedAt: utcTimestampSchema,
  rawResponseDigest: hash32Schema,
  memberSetDigest: hash32Schema,
  candidateListDigest: hash32Schema,
  revision: officialAssetSnapshotRevisionSchema,
}).strict().superRefine((value, context) => {
  if (value.sourceUri !== officialAssetSourceDefinition.sourceUri) {
    context.addIssue({
      code: "custom",
      message: "Official asset evidence source is invalid.",
    });
  }
});
export type OfficialAssetSnapshotEvidence = z.infer<
  typeof officialAssetSnapshotEvidenceSchema
>;

export const projectOfficialAssetSnapshotEvidence = (
  snapshotInput: CommittedOfficialAssetSnapshot,
): OfficialAssetSnapshotEvidence => {
  const snapshot = assertCommittedOfficialAssetSnapshot(snapshotInput);
  return deepFreezeValue(officialAssetSnapshotEvidenceSchema.parse({
    sourceUri: snapshot.sourceUri,
    sourceObservedAt: snapshot.sourceObservedAt,
    rawResponseDigest: snapshot.rawResponseDigest,
    memberSetDigest: snapshot.memberSetDigest,
    candidateListDigest: snapshot.candidateListDigest,
    revision: snapshot.revision,
  }));
};

export const officialAssetSourceFailureDefinitions = deepFreezeValue([
  { code: "request_aborted", classificationReason: false },
  { code: "rate_limited", classificationReason: true },
  { code: "official_asset_response_too_large", classificationReason: true },
  { code: "official_asset_response_unavailable", classificationReason: true },
  { code: "source_inconsistent", classificationReason: true },
  { code: "source_unavailable", classificationReason: true },
] as const);

export type OfficialAssetSourceUnavailableReason =
  (typeof officialAssetSourceFailureDefinitions)[number]["code"];

export const officialAssetSourceUnavailableReasons = Object.freeze(
  officialAssetSourceFailureDefinitions.map((definition) => definition.code),
) as readonly [
  OfficialAssetSourceUnavailableReason,
  ...OfficialAssetSourceUnavailableReason[],
];

export const officialAssetSourceUnavailableReasonSchema = z.enum(
  officialAssetSourceUnavailableReasons,
);

type OfficialAssetSourceClassificationFailureDefinition =
  (typeof officialAssetSourceFailureDefinitions)[number] extends infer Definition
    ? Definition extends { readonly classificationReason: true }
      ? Definition
      : never
    : never;

export type OfficialAssetSourceClassificationUnavailableReason =
  OfficialAssetSourceClassificationFailureDefinition["code"];

export const officialAssetSourceClassificationUnavailableReasons = Object.freeze(
  officialAssetSourceFailureDefinitions
    .filter((definition) => definition.classificationReason)
    .map((definition) => definition.code),
) as readonly [
  OfficialAssetSourceClassificationUnavailableReason,
  ...OfficialAssetSourceClassificationUnavailableReason[],
];

export const officialAssetSourceClassificationUnavailableReasonSchema = z.enum(
  officialAssetSourceClassificationUnavailableReasons,
);

export const stockFactoryClassificationUnavailableReasons = Object.freeze(
  [
    "chain_response_unavailable",
    "factory_identity_mismatch",
    "rate_limited",
    "source_inconsistent",
    "source_unavailable",
    "token_code_missing",
    "token_identity_mismatch",
  ] as const,
);

export type StockFactoryClassificationUnavailableReason =
  (typeof stockFactoryClassificationUnavailableReasons)[number];

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

const verifiedStockFactoryResultSchema = jsonObject({
  status: z.literal("verified"),
  member: officialAssetSourceMemberSchema,
  verification: stockFactoryVerificationSchema,
}).strict();

export const unavailableStockFactoryResultSchema = jsonObject({
  status: z.literal("unavailable"),
  member: officialAssetSourceMemberSchema,
  reason: stockFactoryClassificationUnavailableReasonSchema,
}).strict();

export const stockFactoryVerificationResultSchema = z.discriminatedUnion("status", [
  verifiedStockFactoryResultSchema,
  unavailableStockFactoryResultSchema,
]).superRefine((value, context) => {
  if (
    value.status === "verified" &&
    (
      value.verification.assetUid !== value.member.assetUid ||
      value.verification.contractAddress !== value.member.contractAddress
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "StockFactory verification result member is inconsistent.",
    });
  }
});
export type StockFactoryVerificationResult = z.infer<
  typeof stockFactoryVerificationResultSchema
>;

export const assertStockFactoryVerificationResult = (
  input: StockFactoryVerificationResult,
): StockFactoryVerificationResult => deepFreezeValue(
  stockFactoryVerificationResultSchema.parse(input),
);
