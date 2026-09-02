import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  canonicalJsonStringify,
  parseEvmAddressInput,
  parseHash32,
  parseUtcTimestamp,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  assertCommittedOfficialAssetSnapshot,
  assertStockFactoryVerificationResult,
  officialAssetCandidateListDigest,
  officialAssetCandidateSchema,
  officialAssetMemberSetDigest,
  officialAssetSnapshotEvidenceSchema,
  officialAssetSnapshotRevisionSchema,
  officialAssetSourceDefinition,
  projectOfficialAssetSnapshotEvidence,
  stockFactoryAdmissionManifest,
  stockFactoryVerificationResultSchema,
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
    expect(officialAssetSourceDefinition).toEqual({
      sourceUri: "https://api.robinhood.com/rhj/assets",
      documentationSourceUri: "https://docs.robinhood.com/chain/contracts/",
      chainId: "eip155:4663",
      memberLimit: 512,
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
    expect(Object.isFrozen(officialAssetSourceDefinition)).toBe(true);
    expect(Object.isFrozen(stockFactoryAdmissionManifest)).toBe(true);
  });

  it("preserves the independent official-candidate schema projection", () => {
    const canonical = canonicalOutputSchema(officialAssetCandidateSchema);
    expect(Buffer.byteLength(canonical, "utf8")).toBe(431);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(
      "a2a3edd7a20f92e8f7584e67a3a348b310fe70386dcebf98e910ad70b5e87ffa",
    );
  });

  it("projects one complete public evidence value from the admitted snapshot", () => {
    const members = [{
      assetUid: parseHash32(`0x${"33".repeat(32)}`),
      contractAddress: parseEvmAddressInput(`0x${"44".repeat(20)}`),
      sourceName: "Example Stock Token",
      sourceSymbol: "EXT",
    }];
    const snapshot = assertCommittedOfficialAssetSnapshot({
      sourceUri: officialAssetSourceDefinition.sourceUri,
      sourceObservedAt: parseUtcTimestamp("2026-07-20T00:00:00.000Z"),
      rawResponseDigest: parseHash32(`0x${"11".repeat(32)}`),
      memberSetDigest: officialAssetMemberSetDigest(members),
      candidateListDigest: officialAssetCandidateListDigest(members),
      chainId: officialAssetSourceDefinition.chainId,
      members,
      revision: officialAssetSnapshotRevisionSchema.parse(
        Buffer.alloc(16, 1).toString("base64url"),
      ),
      updatedAt: parseUtcTimestamp("2026-07-20T00:00:01.000Z"),
    });

    const evidence = projectOfficialAssetSnapshotEvidence(snapshot);
    expect(evidence).toEqual({
      sourceUri: snapshot.sourceUri,
      sourceObservedAt: snapshot.sourceObservedAt,
      rawResponseDigest: snapshot.rawResponseDigest,
      memberSetDigest: snapshot.memberSetDigest,
      candidateListDigest: snapshot.candidateListDigest,
      revision: snapshot.revision,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it("rejects foreign source evidence and forged fixed StockFactory identity", () => {
    expect(() => officialAssetSnapshotEvidenceSchema.parse({
      sourceUri: "https://example.invalid/assets",
      sourceObservedAt: "2026-07-20T00:00:00.000Z",
      rawResponseDigest: `0x${"11".repeat(32)}`,
      memberSetDigest: `0x${"22".repeat(32)}`,
      candidateListDigest: `0x${"33".repeat(32)}`,
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
    const member = {
      assetUid: `0x${"33".repeat(32)}`,
      contractAddress: parseEvmAddressInput(`0x${"44".repeat(20)}`),
    };
    expect(() => stockFactoryVerificationResultSchema.parse({
      status: "verified",
      member,
      verification: {
        assetUid: member.assetUid,
        contractAddress: parseEvmAddressInput(`0x${"45".repeat(20)}`),
        block: {
          chainId: "eip155:4663",
          blockNumber: "42",
          blockHash: `0x${"55".repeat(32)}`,
          blockTimestamp: "2026-07-20T00:00:00.000Z",
        },
        proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
        proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
        implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
        implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
        tokenCodeHash: `0x${"77".repeat(32)}`,
      },
    })).toThrow("member is inconsistent");
    const unavailable = assertStockFactoryVerificationResult({
      status: "unavailable",
      member: {
        assetUid: parseHash32(member.assetUid),
        contractAddress: member.contractAddress,
      },
      reason: "source_unavailable",
    });
    expect(Object.isFrozen(unavailable)).toBe(true);
    expect(Object.isFrozen(unavailable.member)).toBe(true);
  });
});
