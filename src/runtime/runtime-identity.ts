import { randomBytes } from "node:crypto";

import { z } from "zod";

import {
  canonicalBase64UrlSchema,
  parseUnsignedDecimal,
  unsignedDecimalSchema,
  type UnsignedDecimal,
} from "../core/index.js";
import { guardRuntimeJsonSchema, parseRuntimeAuthority } from "./schema-authority.js";

export const runtimeProtocolVersion = 1 as const;
export const runtimeIdentifierByteLength = 16 as const;
export const runtimeIdentifierEncodedLength = Math.ceil(runtimeIdentifierByteLength * 4 / 3);
export const runtimeIdentityChallengeByteLength = 32 as const;
export const runtimeIdentityProofByteLength = 32 as const;

const createRuntimeIdentitySchemaSet = () => {
  const profileId = canonicalBase64UrlSchema(runtimeIdentifierByteLength).brand("ProfileId");
  const ownerInstanceId = canonicalBase64UrlSchema(runtimeIdentifierByteLength).brand("OwnerInstanceId");
  const challenge = canonicalBase64UrlSchema(runtimeIdentityChallengeByteLength)
    .brand("RuntimeIdentityChallenge");
  const proof = canonicalBase64UrlSchema(runtimeIdentityProofByteLength).brand("RuntimeIdentityProof");
  const unsignedIdentity = z.object({
    profileId,
    ownerInstanceId,
    runtimeProtocolVersion: z.literal(runtimeProtocolVersion),
    challenge,
    ownerRevision: unsignedDecimalSchema,
  }).strict();
  const ownerIdentity = unsignedIdentity.extend({ proof }).strict();
  return Object.freeze({
    profileId,
    ownerInstanceId,
    challenge,
    unsignedIdentity,
    ownerIdentity,
  });
};

const publicSchemas = createRuntimeIdentitySchemaSet();
const authoritySchemas = createRuntimeIdentitySchemaSet();

export const ownerIdentitySchema = guardRuntimeJsonSchema(publicSchemas.ownerIdentity);
export type OwnerIdentity = z.infer<typeof ownerIdentitySchema>;
export type UnsignedOwnerIdentity = Omit<OwnerIdentity, "proof">;

export type ProfileId = ReturnType<typeof parseProfileId>;
export type OwnerInstanceId = ReturnType<typeof parseOwnerInstanceId>;
export type RuntimeIdentityChallenge = ReturnType<typeof parseRuntimeIdentityChallenge>;
export type RuntimeRevision = UnsignedDecimal;

export const parseProfileId = (value: unknown) => authoritySchemas.profileId.parse(value);
export const parseOwnerInstanceId = (value: unknown) => authoritySchemas.ownerInstanceId.parse(value);
export const parseRuntimeIdentityChallenge = (value: unknown) => authoritySchemas.challenge.parse(value);
export const parseRuntimeRevision = (value: unknown): RuntimeRevision => parseUnsignedDecimal(value);
export const parseOwnerIdentity = (value: unknown): OwnerIdentity =>
  parseRuntimeAuthority(authoritySchemas.ownerIdentity, value);
export const parseUnsignedOwnerIdentity = (value: unknown): UnsignedOwnerIdentity =>
  parseRuntimeAuthority(authoritySchemas.unsignedIdentity, value);

export const createProfileId = (): ProfileId =>
  parseProfileId(randomBytes(runtimeIdentifierByteLength).toString("base64url"));

export const createOwnerInstanceId = (): OwnerInstanceId =>
  parseOwnerInstanceId(randomBytes(runtimeIdentifierByteLength).toString("base64url"));

export const createRuntimeIdentityChallenge = (): RuntimeIdentityChallenge =>
  parseRuntimeIdentityChallenge(randomBytes(runtimeIdentityChallengeByteLength).toString("base64url"));

const identityFields = (identity: UnsignedOwnerIdentity): readonly string[] => [
  identity.profileId,
  identity.ownerInstanceId,
  String(identity.runtimeProtocolVersion),
  identity.challenge,
  identity.ownerRevision,
];

export const encodeOwnerProofPayload = (input: UnsignedOwnerIdentity): Uint8Array => {
  const identity = parseUnsignedOwnerIdentity(input);
  const encoded = identityFields(identity).map((field) => Buffer.from(field, "utf8"));
  const totalLength = encoded.reduce((sum, field) => sum + 4 + field.length, 0);
  const output = Buffer.alloc(totalLength);
  let offset = 0;
  for (const field of encoded) {
    output.writeUInt32BE(field.length, offset);
    offset += 4;
    field.copy(output, offset);
    offset += field.length;
  }
  return output;
};

export const unsignedDecimalSqlCheck = (column: string): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(column)) throw new TypeError("SQLite identifier is invalid.");
  return `${column} NOT GLOB '*[^0-9]*' AND (${column} = '0' OR ${column} GLOB '[1-9]*')`;
};
