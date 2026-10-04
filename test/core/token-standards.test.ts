import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {canonicalJsonStringify, type CanonicalJson} from "../../src/core/index.js";
import {requiredErc8056ObservationSchema, tokenStandardObservationResultSchema, tokenStandardObservationSchema} from "../../src/evm/token-standards.js";

const canonicalOutputSchema = (schema: z.ZodType): string =>
  canonicalJsonStringify(JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io: "output",
  }))) as CanonicalJson);

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

describe("token standard contract", () => {
  it("preserves every independent token-standard schema projection", () => {
    for (const [schema, expectedBytes, expectedDigest] of [
      [
        tokenStandardObservationSchema,
        402,
        "caf635df11febb07c9b2aeab428613e6269ffef2efb8e4ab242521da7ac2653f",
      ],
      [
        requiredErc8056ObservationSchema,
        2_555,
        "0e615eb7072e5165dd508b7bc76494196c77830195ce67afb1447249ef4f8689",
      ],
      [
        tokenStandardObservationResultSchema,
        3_005,
        "d35cf2ba6d406ee3dbfbb3db60099d69fcb70b421c78504ec837ca4d89f3480e",
      ],
    ] as const) {
      const canonical = canonicalOutputSchema(schema);
      expect(Buffer.byteLength(canonical, "utf8")).toBe(expectedBytes);
      expect(sha256(canonical)).toBe(expectedDigest);
    }
  });
});
