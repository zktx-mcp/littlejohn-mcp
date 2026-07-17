import { describe, expect, it } from "vitest";

import {
  evidenceSourceSchema,
  fieldIssueSchema,
  conclusionSchema,
  coverageSchema,
  createCanonicalClock,
  createObservationAuthority,
  freshnessSchema,
  warningSchema,
  sourceReferenceSchema,
} from "../../src/core/index.js";
import { createWarning } from "../../src/core/evidence.js";

const canonicalInvocationId = `inv:${Buffer.alloc(32, 2).toString("base64url")}`;

const validEvidenceSource = () => ({
  observationId: `obs:${"A".repeat(43)}`,
  invocationId: canonicalInvocationId,
  sourceClass: "chain_rpc" as const,
  owner: "provider",
  purpose: "latest_block",
  observedAt: "2026-07-12T10:16:02.000Z",
  reference: { kind: "public" as const, sourceId: "rpc_test", uri: "https://rpc.example/" },
});

describe("evidence identity", () => {
  it("binds source identifiers to keyed digests without exposing private values", () => {
    const digest = "A".repeat(43);
    expect(sourceReferenceSchema.safeParse({
      kind: "configured_rpc",
      sourceId: `rpc:${digest}`,
      publicOrigin: "https://rpc.example",
      configurationDigest: digest,
    }).success).toBe(true);
    expect(sourceReferenceSchema.safeParse({
      kind: "configured_rpc",
      sourceId: `rpc:${"B".repeat(43)}`,
      publicOrigin: "https://rpc.example",
      configurationDigest: digest,
    }).success).toBe(false);
  });

  it("rejects non-canonical base64url even when it decodes to the same digest bytes", () => {
    const bytes = Buffer.alloc(32, 1);
    const canonical = bytes.toString("base64url");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const index = alphabet.indexOf(canonical.at(-1) as string);
    const alternate = `${canonical.slice(0, -1)}${alphabet[index + 1]}`;
    expect(Buffer.from(alternate, "base64url").equals(bytes)).toBe(true);
    expect(sourceReferenceSchema.safeParse({
      kind: "configured_rpc",
      sourceId: `rpc:${alternate}`,
      publicOrigin: "https://rpc.example",
      configurationDigest: alternate,
    }).success).toBe(false);
    const valid = validEvidenceSource();
    expect(evidenceSourceSchema.safeParse(valid).success).toBe(true);
    expect(evidenceSourceSchema.safeParse({ ...valid, observationId: `obs:${alternate}` }).success).toBe(false);
  });

  it("rejects a source class paired with a different reference authority", () => {
    const valid = validEvidenceSource();
    expect(evidenceSourceSchema.safeParse(valid).success).toBe(true);
    expect(evidenceSourceSchema.safeParse({
      ...valid,
      sourceClass: "wallet_session",
      owner: "wallet",
      purpose: "wallet_session",
      reference: { kind: "public", sourceId: "wallet", uri: "https://example.com/" },
    }).success).toBe(false);
  });

  it("requires one canonical public invocation identifier on every evidence source", () => {
    const source = {
      ...validEvidenceSource(),
    };
    expect(evidenceSourceSchema.safeParse(source).success).toBe(true);
    expect(evidenceSourceSchema.safeParse({ ...source, invocationId: undefined }).success).toBe(false);
    expect(evidenceSourceSchema.safeParse({ ...source, invocationId: "inv:not-canonical" }).success).toBe(false);
  });

  it("accepts public evidence only through credential-free HTTPS references", () => {
    expect(sourceReferenceSchema.safeParse({
      kind: "public",
      sourceId: "official_reference",
      uri: "https://docs.example/reference",
    }).success).toBe(true);
    for (const uri of [
      "https://docs.example",
      "HTTPS://DOCS.EXAMPLE:443/reference",
      "https://@docs.example/reference",
      "https://docs.example/a/../reference",
      "http://docs.example/reference",
      "ftp://docs.example/reference",
      "file:///tmp/reference",
      "data:text/plain,reference",
      "javascript:alert(1)",
      "https://user:password@docs.example/reference",
    ]) {
      expect(sourceReferenceSchema.safeParse({
        kind: "public",
        sourceId: "official_reference",
        uri,
      }).success).toBe(false);
    }
  });

  it("binds every warning code to its one registry-owned fixed message", () => {
    const observationIds = [`obs:${"A".repeat(43)}`];
    expect(warningSchema.safeParse({
      code: "partial_result",
      message: "Some requested results are unavailable.",
      observationIds,
    }).success).toBe(true);
    expect(warningSchema.safeParse({
      code: "partial_result",
      message: "An arbitrary safe message.",
      observationIds,
    }).success).toBe(false);

    const runtime = (warningSchema as unknown as { _zod: { run: unknown } })._zod;
    const original = runtime.run;
    try {
      runtime.run = () => ({
        value: { code: "partial_result", message: "Injected warning text.", observationIds },
        issues: [],
      });
      expect(createWarning("partial_result", observationIds as never).message)
        .toBe("Some requested results are unavailable.");
    } finally {
      runtime.run = original;
    }
    expect(() => createWarning("partial_result", [] as never)).toThrow();
    expect(() => createWarning("partial_result", ["obs:not-canonical"] as never)).toThrow();
  });

  it("keeps source authority parsing independent from a caller-mutated public schema", () => {
    const runtime = (sourceReferenceSchema as unknown as { _zod: { run: unknown } })._zod;
    const original = runtime.run;
    const unsafe = {
      kind: "public",
      sourceId: "official_reference",
      uri: "javascript:alert(1)",
    };
    try {
      runtime.run = () => ({ value: unsafe, issues: [] });
      const poisoned = sourceReferenceSchema.parse(unsafe);
      const clock = createCanonicalClock(() => "2026-07-12T10:16:02.000Z");
      expect(() => createObservationAuthority({
        clock,
        sourceClass: "official_document",
        owner: "official_owner",
        reference: poisoned,
      })).toThrow();
    } finally {
      runtime.run = original;
    }
  });

  it("accepts only canonical RFC 6901 pointers without embedding a value", () => {
    for (const path of ["", "/a", "/a~1b", "/a~0b", "/0/name"]) {
      expect(fieldIssueSchema.safeParse({ path, code: "invalid_value", message: "The field value is invalid." }).success).toBe(true);
    }
    for (const path of ["a", "/a~2b", "//~", "secret\nvalue"]) {
      expect(fieldIssueSchema.safeParse({ path, code: "invalid_value", message: "The field value is invalid." }).success).toBe(false);
    }
  });

  it("binds conclusion and freshness status to their one definition map", () => {
    const observationIds = [`obs:${"A".repeat(43)}`];
    const freshness = {
      status: "fresh",
      ruleId: "validated_input_current",
      evaluatedAt: "2026-07-12T10:16:02.000Z",
      observationIds,
    };
    expect(freshnessSchema.safeParse(freshness).success).toBe(true);
    expect(freshnessSchema.safeParse({ ...freshness, status: "unknown" }).success).toBe(false);
    expect(conclusionSchema.safeParse({
      id: "input_validated",
      status: "established",
      reason: "validated_input",
      observationIds,
      freshness,
    }).success).toBe(true);
    expect(conclusionSchema.safeParse({
      id: "input_validated",
      status: "unavailable",
      reason: "validated_input",
      observationIds,
      freshness,
    }).success).toBe(false);
  });

  it("binds coverage status to the exact outcome partitions", () => {
    expect(coverageSchema.safeParse({
      status: "complete",
      established: ["a"],
      notApplicable: [],
      unavailable: [],
    }).success).toBe(true);
    expect(coverageSchema.safeParse({
      status: "complete",
      established: [],
      notApplicable: [],
      unavailable: ["a"],
    }).success).toBe(false);
    expect(coverageSchema.safeParse({
      status: "unavailable",
      established: [],
      notApplicable: [],
      unavailable: ["a"],
    }).success).toBe(true);
  });
});
