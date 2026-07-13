import { z } from "zod";

import { canonicalSha256, type CanonicalJson } from "./canonical-json.js";
import { createSha256HexSchema, sha256Algorithm } from "./digests.js";
import { deepFreezeValue } from "./immutability.js";
import { guardJsonSchema, jsonObject } from "./json-object.js";
import { compareCodePointSequences, isSafeSingleLineText } from "./primitives.js";

export const runtimeBuildDigest = (files: Readonly<Record<string, string>>): string =>
  canonicalSha256({ algorithm: sha256Algorithm, files } as unknown as CanonicalJson);

const createRuntimeBuildIdentitySchemaSet = () => {
  const sha256Hex = createSha256HexSchema();
  const buildPath = z
    .string()
    .min(1)
    .max(512)
    .superRefine((value, context) => {
      const segments = value.split("/");
      if (
        value.startsWith("/") ||
        value.endsWith("/") ||
        value.includes("\\") ||
        !isSafeSingleLineText(value) ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..")
      ) context.addIssue({ code: "custom", message: "Expected a canonical relative package path." });
    });
  const runtimeBuildFiles = z.record(buildPath, sha256Hex);
  const runtimeBuildIdentity = jsonObject({
      algorithm: z.literal(sha256Algorithm),
      digest: sha256Hex,
      files: runtimeBuildFiles,
    })
    .strict()
    .superRefine((value, context) => {
      if (runtimeBuildDigest(value.files) !== value.digest) {
        context.addIssue({ code: "custom", message: "Build identity digest does not match its file map." });
      }
    });
  return Object.freeze({ sha256Hex, buildPath, runtimeBuildFiles, runtimeBuildIdentity });
};

const publicSchemas = createRuntimeBuildIdentitySchemaSet();
const authoritySchemas = createRuntimeBuildIdentitySchemaSet();
const runtimeBuildIdentityAuthoritySchema = guardJsonSchema(authoritySchemas.runtimeBuildIdentity);

export const buildPathSchema = publicSchemas.buildPath;
export const runtimeBuildIdentitySchema = guardJsonSchema(publicSchemas.runtimeBuildIdentity);
export type RuntimeBuildIdentity = z.infer<typeof runtimeBuildIdentitySchema>;

export const parseRuntimeBuildIdentity = (value: unknown): RuntimeBuildIdentity => {
  const parsed = runtimeBuildIdentityAuthoritySchema.parse(value);
  return deepFreezeValue({ ...parsed, files: { ...parsed.files } });
};

export const createRuntimeBuildIdentity = (
  files: Readonly<Record<string, string>>,
): RuntimeBuildIdentity => {
  const canonicalFiles: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [path, digest] of Object.entries(files).sort(([left], [right]) =>
    compareCodePointSequences(left, right))) {
    canonicalFiles[path] = digest;
  }
  const parsed = runtimeBuildIdentityAuthoritySchema.parse({
    algorithm: sha256Algorithm,
    digest: runtimeBuildDigest(canonicalFiles),
    files: canonicalFiles,
  });
  return deepFreezeValue({ ...parsed, files: { ...parsed.files } });
};
