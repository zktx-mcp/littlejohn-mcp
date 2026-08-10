import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  canonicalSha256,
  captureCanonicalJson,
  type CanonicalJson,
} from "../../src/core/browser.js";
import { parseCapabilitySuccess } from "../../src/core/index.js";
import * as browserContracts from "../../src/token-catalog/browser.js";
import {
  tokenCatalogApplicationContracts as serverApplicationContracts,
  tokenCatalogContractProjection,
  tokenCatalogContractProjectionDigest,
  tokenCatalogOperationConfirmationContract as serverConfirmationContract,
  tokenInspectCapability,
  tokenInspectionSuccessSchema as serverInspectionSuccessSchema,
} from "../../src/token-catalog/contracts.js";
import { tokenCatalogErrorRegistry } from "../../src/token-catalog/error-registry.js";
import { createInspectionSuccess } from "./harness.js";

const independentCanonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${independentCanonicalJson(entry)}`).join(",")}}`;
  }
  throw new TypeError("Unsupported test canonical JSON value.");
};

describe("token catalog browser contract", () => {
  it("uses one canonical parser owner in server and browser graphs", () => {
    expect(browserContracts.tokenCatalogApplicationContracts).toBe(serverApplicationContracts);
    expect(browserContracts.tokenCatalogOperationConfirmationContract).toBe(serverConfirmationContract);
    expect(browserContracts.tokenInspectionSuccessSchema).toBe(serverInspectionSuccessSchema);
    for (const contract of Object.values(serverApplicationContracts)) {
      expect(contract.applicationContract.errorRegistry).toBe(tokenCatalogErrorRegistry);
      expect(contract.contractVersion).toBe(contract.applicationContract.contractVersion);
    }
    expect(serverConfirmationContract.applicationContract.errorRegistry)
      .toBe(tokenCatalogErrorRegistry);
    const fixedDigest =
      "0x7f387cbd5607ff9b3bbb4bf4ce5234ba39dc64d3d6c0d2d5cb58201c03822fcc";
    expect(`0x${createHash("sha256")
      .update(independentCanonicalJson(tokenCatalogContractProjection), "utf8")
      .digest("hex")}`).toBe(fixedDigest);
    expect(tokenCatalogContractProjectionDigest).toBe(fixedDigest);
  });

  it("preserves canonical SHA-256 bytes for ASCII, Unicode, and escaped NUL input", () => {
    const values = [
      captureCanonicalJson({ ascii: "token", count: 3 }),
      captureCanonicalJson({ unicode: "토큰 🏹", nested: ["é", "e\u0301"] }),
      captureCanonicalJson({ nul: "before\u0000after", escaped: "\\u0000" }),
    ] as const;
    for (const value of values) {
      const expected = createHash("sha256")
        .update(canonicalJsonStringify(value as CanonicalJson), "utf8")
        .digest("hex");
      expect(canonicalSha256(value as CanonicalJson)).toBe(expected);
    }
  });

  it("rejects the same cross-identity inspection in both entry points", async () => {
    const success = await createInspectionSuccess();
    expect(browserContracts.tokenInspectionSuccessSchema.parse(success)).toEqual(
      serverInspectionSuccessSchema.parse(success),
    );
    const invalid = JSON.parse(JSON.stringify(success)) as Record<string, unknown>;
    const data = invalid["data"] as Record<string, unknown>;
    data["asset"] = {
      ...(data["asset"] as Record<string, unknown>),
      address: `0x${"34".repeat(20)}`,
    };
    expect(() => browserContracts.tokenInspectionSuccessSchema.parse(invalid)).toThrow();
    expect(() => serverInspectionSuccessSchema.parse(invalid)).toThrow();
  });

  it("keeps generic and browser token evidence rejection semantically identical", async () => {
    const success = await createInspectionSuccess();
    const input = {
      asset: success.data.asset,
      block: { kind: "latest" as const },
    };
    const mutations = [
      (candidate: Record<string, unknown>) => {
        const evidence = candidate["evidence"] as Record<string, unknown>;
        evidence["sources"] = (evidence["sources"] as unknown[]).slice(1);
      },
      (candidate: Record<string, unknown>) => {
        const evidence = candidate["evidence"] as Record<string, unknown>;
        const warningObservationIds = new Set(
          (candidate["warnings"] as Array<Record<string, unknown>>)
            .flatMap((warning) => warning["observationIds"] as string[]),
        );
        const source = (evidence["sources"] as Array<Record<string, unknown>>)
          .find((candidateSource) =>
            !warningObservationIds.has(candidateSource["observationId"] as string));
        if (source === undefined) {
          throw new TypeError("Token fixture has no observation outside the partial-result warning.");
        }
        candidate["warnings"] = [{
          code: "partial_result",
          message: "Some requested results are unavailable.",
          observationIds: [source["observationId"]],
        }];
      },
      (candidate: Record<string, unknown>) => {
        const evidence = candidate["evidence"] as Record<string, unknown>;
        const coverage = evidence["coverage"] as Record<string, unknown>;
        const established = coverage["established"] as unknown[];
        coverage["established"] = [established[0], ...established];
      },
    ] as const;

    for (const mutate of mutations) {
      const invalid = JSON.parse(JSON.stringify(success)) as Record<string, unknown>;
      mutate(invalid);
      expect(() => parseCapabilitySuccess(tokenInspectCapability, input, invalid)).toThrow();
      expect(() => browserContracts.tokenInspectionSuccessSchema.parse(invalid)).toThrow();
      expect(() => serverInspectionSuccessSchema.parse(invalid)).toThrow();
    }
  });
});
