import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  canonicalJsonStringify,
  referenceRoundReadEvidenceSchema,
  sourceReferenceSchema,
  type CanonicalJson,
} from "../../src/core/index.js";

const projectCanonicalOutputSchema = (schema: z.ZodType): string =>
  canonicalJsonStringify(JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io: "output",
  }))) as CanonicalJson);

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

describe("shared evidence consumer boundaries", () => {
  it("preserves the exact source-reference output schema and variant order", () => {
    const canonical = projectCanonicalOutputSchema(sourceReferenceSchema);
    expect(Buffer.byteLength(canonical, "utf8")).toBe(1_517);
    expect(sha256(canonical)).toBe(
      "86b196388387f8ba012b87438887809760588e723c522f4513e82e8f823c52fe",
    );

    const projection = JSON.parse(canonical) as {
      oneOf?: readonly {
        properties?: Readonly<{ kind?: Readonly<{ const?: unknown }> }>;
      }[];
    };
    expect(projection.oneOf?.map((variant) => variant.properties?.kind?.const)).toEqual([
      "public",
      "configured_rpc",
      "wallet_session",
      "wallet_sdk",
      "validated_input",
    ]);
  });

  it("preserves the exact reference-round read-evidence output schema", () => {
    const canonical = projectCanonicalOutputSchema(referenceRoundReadEvidenceSchema);
    expect(Buffer.byteLength(canonical, "utf8")).toBe(2_770);
    expect(sha256(canonical)).toBe(
      "782a26558f5f73c08398f1ca42a5b197ce63db590db55f3d3c0cdc766cc13520",
    );
  });
});
