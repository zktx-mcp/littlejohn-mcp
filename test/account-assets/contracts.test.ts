import { beforeAll, describe, expect, it } from "vitest";

import {
  accountAssetApplicationContracts,
  accountAssetMetadataAuthority,
  accountAssetSourceReferenceSchema,
  projectAccountAssetCollectionSuccess,
} from "../../src/account-assets/contracts.js";
import { createAccountAssetFailure } from "../../src/account-assets/errors.js";
import { projectAccountAssetEntry } from "../../src/account-assets/metadata.js";
import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import { accountBalanceCapability, maximumEvmBalanceRaw } from "../../src/core/index.js";
import {
  tokenInspectionDigest,
  tokenRegistrationWithInspectionSchema,
} from "../../src/token-catalog/index.js";
import {
  ScriptedRpc,
  connectedWallet,
  createChainHandlerHarness,
  rpcValue,
} from "../chain/handler-harness.js";
import {
  chainId,
  createInspectionSuccess,
  walletAddress,
} from "../token-catalog/harness.js";

let encoder: Erc20CallEncoder;
beforeAll(async () => { encoder = await createErc20CallEncoder(); });

const storedRegistration = async () => {
  const inspection = await createInspectionSuccess();
  return tokenRegistrationWithInspectionSchema.parse({
    registration: {
      account: { chainId, address: walletAddress },
      asset: inspection.data.asset,
      revision: Buffer.alloc(16, 1).toString("base64url"),
      inspectionDigest: tokenInspectionDigest(inspection),
      createdAt: "2026-07-18T00:00:03.000Z",
    },
    inspection,
  });
};

describe("account asset public contract", () => {
  it("normalizes repeated metadata source references into one result-level entry", async () => {
    const stored = await storedRegistration();
    const projectedEntry = projectAccountAssetEntry(stored);
    const result = projectAccountAssetCollectionSuccess({
      account: stored.registration.account,
      metadataAuthority: accountAssetMetadataAuthority,
      assets: [projectedEntry],
      nextCursor: null,
      balance: {
        status: "unavailable",
        failure: createAccountAssetFailure("source_unavailable"),
      },
    });

    expect(result.sourceReferences).toHaveLength(1);
    expect(result.assets[0]?.metadata.name.source.sourceId)
      .toBe(result.assets[0]?.metadata.symbol.source.sourceId);

    const conflictingEntry = structuredClone(projectedEntry);
    const symbolReference = conflictingEntry.metadata.symbol.source.reference;
    if (symbolReference.kind !== "configured_rpc") throw new TypeError();
    Reflect.set(symbolReference, "publicOrigin", "https://conflict.example");
    expect(() => projectAccountAssetCollectionSuccess({
      account: stored.registration.account,
      metadataAuthority: accountAssetMetadataAuthority,
      assets: [conflictingEntry],
      nextCursor: null,
      balance: {
        status: "unavailable",
        failure: createAccountAssetFailure("source_unavailable"),
      },
    })).toThrow();
  });

  it("normalizes and validates an available canonical account balance", async () => {
    const stored = await storedRegistration();
    const block = {
      number: "0x2a",
      hash: `0x${"88".repeat(32)}`,
      timestamp: "0x65a00000",
      transactions: [],
    };
    const abiWord = (value: bigint): `0x${string}` =>
      `0x${value.toString(16).padStart(64, "0")}`;
    const chain = createChainHandlerHarness({
      rpc: new ScriptedRpc([
        rpcValue("eth_chainId", "0x1237"),
        rpcValue("eth_getBlockByNumber", block),
        rpcValue("eth_getBalance", "0x64"),
        rpcValue("eth_call", abiWord(1n)),
        rpcValue("eth_call", abiWord(6n)),
      ]),
      encoder,
      wallet: connectedWallet(walletAddress),
    });
    try {
      const balance = await chain.invoke(accountBalanceCapability, {
        account: { kind: "address", address: walletAddress },
        includeNative: true,
        tokens: [stored.registration.asset.address],
        block: { kind: "latest" },
      });
      if (!balance.ok) throw new TypeError(balance.error.code);
      const result = projectAccountAssetCollectionSuccess({
        account: stored.registration.account,
        metadataAuthority: accountAssetMetadataAuthority,
        assets: [projectAccountAssetEntry(stored)],
        nextCursor: null,
        balance: { status: "available", snapshot: balance },
      });
      expect(result.balance.status).toBe("available");
      expect(result.sourceReferences).toHaveLength(3);

      if (result.balance.status !== "available") throw new TypeError();
      const token = result.balance.snapshot.data.tokens[0];
      if (token?.result.status !== "available") throw new TypeError();
      const invalidAmountIdentity = {
        ...result,
        balance: {
          ...result.balance,
          snapshot: {
            ...result.balance.snapshot,
            data: {
              ...result.balance.snapshot.data,
              tokens: [{
                ...token,
                result: {
                  ...token.result,
                  amount: {
                    ...token.result.amount,
                    asset: { kind: "native", chainId },
                  },
                },
              }],
            },
          },
        },
      };
      expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
        { limit: 5, cursor: null },
        invalidAmountIdentity,
      )).toThrow();

      const excessiveBalance = structuredClone(result);
      if (excessiveBalance.balance.status !== "available" ||
        excessiveBalance.balance.snapshot.data.native.status !== "available") throw new TypeError();
      Reflect.set(
        excessiveBalance.balance.snapshot.data.native.amount,
        "raw",
        `${maximumEvmBalanceRaw}0`,
      );
      expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
        { limit: 5, cursor: null },
        excessiveBalance,
      )).toThrow();

      const invalidMetadataSource = structuredClone(result);
      const nameSource = invalidMetadataSource.assets[0]!.metadata.name.source;
      Reflect.set(nameSource, "sourceClass", "validated_input");
      Reflect.set(nameSource, "owner", "Little John validated input");
      Reflect.set(nameSource, "sourceId", "input:account.balance");
      Reflect.deleteProperty(nameSource, "chainAnchor");
      expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
        { limit: 5, cursor: null },
        invalidMetadataSource,
      )).toThrow();

      const unrelatedCoverage = structuredClone(result);
      const metadata = unrelatedCoverage.assets[0]!.metadata;
      Reflect.set(metadata, "coverage", {
        ...metadata.coverage,
        established: [...metadata.coverage.established, "total_supply_observed"].sort(),
      });
      expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
        { limit: 5, cursor: null },
        unrelatedCoverage,
      )).toThrow();

      const invalidFreshness = structuredClone(result);
      Reflect.set(
        invalidFreshness.assets[0]!.metadata.name.conclusion.freshness,
        "evaluatedAt",
        "2026-07-18T00:00:04.000Z",
      );
      expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
        { limit: 5, cursor: null },
        invalidFreshness,
      )).toThrow();

      const omittedFactWarning = structuredClone(result);
      if (omittedFactWarning.balance.status !== "available") throw new TypeError();
      Reflect.set(
        omittedFactWarning.assets[0]!.metadata,
        "warnings",
        [omittedFactWarning.balance.snapshot.warnings[0]!],
      );
      expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
        { limit: 5, cursor: null },
        omittedFactWarning,
      )).toThrow();

      expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
        { limit: 5, cursor: null },
        { ...result, sourceReferences: result.sourceReferences.slice(1) },
      )).toThrow();
      expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
        { limit: 5, cursor: null },
        { ...result, sourceReferences: [...result.sourceReferences, result.sourceReferences[0]!] },
      )).toThrow();
      expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
        { limit: 5, cursor: null },
        { ...result, sourceReferences: [...result.sourceReferences].reverse() },
      )).toThrow();
      const unusedDigest = Buffer.alloc(32, 9).toString("base64url");
      const unusedReference = accountAssetSourceReferenceSchema.parse({
        kind: "configured_rpc",
        sourceId: `rpc:${unusedDigest}`,
        publicOrigin: "https://unused.example",
        configurationDigest: unusedDigest,
      });
      expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
        { limit: 5, cursor: null },
        {
          ...result,
          sourceReferences: [...result.sourceReferences, unusedReference]
            .sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0),
        },
      )).toThrow();
      expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
        { limit: 5, cursor: null },
        {
          ...result,
          sourceReferences: [...result.sourceReferences, {
            kind: "public",
            sourceId: "unapproved_source",
            uri: "https://example.com/",
          }],
        },
      )).toThrow();
    } finally {
      await chain.close();
    }
  });
});
