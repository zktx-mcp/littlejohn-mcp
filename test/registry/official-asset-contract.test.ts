import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  canonicalJsonStringify,
  parseEvmAddressInput,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  officialAssetCandidateSchema,
  officialAssetSnapshotEvidenceSchema,
  officialAssetSourceManifest,
  stockFactoryAdmissionManifest,
  stockFactoryClassificationUnavailableReasons,
  stockFactoryVerificationFailureDefinitions,
  stockFactoryVerificationSchema,
} from "../../src/registry/official-asset-contract.js";

const canonicalOutputSchema = (schema: z.ZodType): string =>
  canonicalJsonStringify(JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io: "output",
  }))) as CanonicalJson);

describe("official asset contract", () => {
  it("owns the exact official source and StockFactory admission manifests", () => {
    expect(officialAssetSourceManifest).toEqual({
      sourceUri: "https://api.robinhood.com/rhj/assets",
      documentationSourceUri: "https://docs.robinhood.com/chain/contracts/",
      chainId: "eip155:4663",
      deploymentChainId: 4663,
      activeStatus: "ASSET_STATUS_ACTIVE",
      responseByteLimit: 1_048_576,
      memberLimit: 512,
      deploymentLimit: 8,
      responseDeadlineMs: 10_000,
    });
    expect(stockFactoryAdmissionManifest).toEqual({
      chainId: "eip155:4663",
      proxyAddress: "0x4783c67b63de2b358ac5951a7d41f47a38f3c046",
      implementationAddress: "0xee351e53bce6aaf106428358838197c91e36ee0e",
      implementationSlot:
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
      proxyCodeHash:
        "0x394c3517e9331e7c88ef8af388c0cb63c720af1b1b4d5a5cace212f7df0b045a",
      implementationCodeHash:
        "0x3bfd5841605b9931c9dbb0f9f54a28b4038918ceb74d6d1081bc7f963fe528b4",
      observedOn: "2026-07-20",
      observationBlockNumber: "14660943",
      observationBlockHash:
        "0x94d90a8691fc4fc7a4fb48a86755f948f2a1110325d6c8257dbfeaddaf8832b0",
      proxySourceUri:
        "https://robinhoodchain.blockscout.com/address/0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046",
      implementationSourceUri:
        "https://robinhoodchain.blockscout.com/address/0xEe351E53BCe6AAF106428358838197C91e36EE0E",
    });
    expect(Object.isFrozen(officialAssetSourceManifest)).toBe(true);
    expect(Object.isFrozen(stockFactoryAdmissionManifest)).toBe(true);
  });

  it("preserves the independent official-candidate schema projection", () => {
    const canonical = canonicalOutputSchema(officialAssetCandidateSchema);
    expect(Buffer.byteLength(canonical, "utf8")).toBe(431);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(
      "a2a3edd7a20f92e8f7584e67a3a348b310fe70386dcebf98e910ad70b5e87ffa",
    );
  });

  it("derives the full and classification failure languages from one ordered owner", () => {
    expect(stockFactoryVerificationFailureDefinitions.map(({ code }) => code)).toEqual([
      "factory_identity_mismatch",
      "request_aborted",
      "source_inconsistent",
      "source_unavailable",
      "token_code_missing",
      "token_identity_mismatch",
    ]);
    expect(stockFactoryClassificationUnavailableReasons).toEqual([
      "factory_identity_mismatch",
      "source_inconsistent",
      "source_unavailable",
      "token_code_missing",
      "token_identity_mismatch",
    ]);
  });

  it("rejects foreign source evidence and forged fixed StockFactory identity", () => {
    expect(() => officialAssetSnapshotEvidenceSchema.parse({
      sourceUri: "https://example.invalid/assets",
      sourceObservedAt: "2026-07-20T00:00:00.000Z",
      rawResponseDigest: `0x${"11".repeat(32)}`,
      memberSetDigest: `0x${"22".repeat(32)}`,
      revision: Buffer.alloc(16, 1).toString("base64url"),
    })).toThrow();
    expect(() => stockFactoryVerificationSchema.parse({
      assetUid: `0x${"33".repeat(32)}`,
      contractAddress: parseEvmAddressInput(`0x${"44".repeat(20)}`),
      block: {
        chainId: "eip155:4663",
        blockNumber: "42",
        blockHash: `0x${"55".repeat(32)}`,
        blockTimestamp: "2026-07-20T00:00:00.000Z",
      },
      proxyAddress: parseEvmAddressInput(`0x${"66".repeat(20)}`),
      proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
      implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
      implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
      tokenCodeHash: `0x${"77".repeat(32)}`,
    })).toThrow();
  });
});
