import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  accountAssetApplicationContracts,
  accountAssetAmountSchema,
  accountAssetClassificationSchema,
  accountAssetCursorSchema,
  accountAssetLimits,
  contractAccountAssetSchema,
  createAccountAssetAmount,
  nativeAccountAssetSchema,
} from "../../src/account-assets/contracts.js";
import {canonicalJsonStringify, parseUtcTimestamp, type CanonicalJson} from "../../src/core/index.js";
import {calculateScaledUiAmount} from "../../src/evm/amounts.js";
import {parseEvmAddressInput} from "../../src/evm/address-input.js";
import {parseEvmChainId} from "../../src/evm/identities.js";
import {requiredErc8056ObservationSchema} from "../../src/evm/token-standards.js";
import {
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
} from "../../src/token-catalog/index.js";
import { tokenCatalogErrorRegistry } from "../../src/token-catalog/error-registry.js";
import {
  officialAssetSourceDefinition,
  stockFactoryAdmissionManifest,
} from "../../src/registry/client.js";
import { defaultStockTokenManifest } from "../../src/registry/index.js";

const chainId = parseEvmChainId("eip155:4663");
const accountAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
const foreignAccountAddress = parseEvmAddressInput(`0x${"35".repeat(20)}`);
const at = parseUtcTimestamp("2026-07-21T00:00:00.000Z");
const account = Object.freeze({ chainId, address: accountAddress });
const target = Object.freeze({ kind: "address" as const, address: accountAddress });
const selectionSetRevision = tokenSelectionSetRevisionSchema.parse(
  Buffer.alloc(16, 2).toString("base64url"),
);
const block = Object.freeze({
  chainId,
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: at,
});
const viewRevision = Object.freeze({
  account,
  officialSnapshotStatus: "unavailable" as const,
  officialSnapshotRevision: null,
  officialSnapshotUnavailableReason: "source_unavailable" as const,
  selectionSetRevision,
});

const contractAsset = (index: number, addressInput?: string) => {
  const address = parseEvmAddressInput(addressInput ?? `0x${index.toString(16).padStart(40, "0")}`);
  const asset = Object.freeze({ kind: "erc20" as const, chainId, address });
  return Object.freeze({
    kind: "erc20" as const,
    selection: {
      account,
      asset,
      included: true,
      revision: tokenSelectionRevisionSchema.parse(
        Buffer.alloc(16, index).toString("base64url"),
      ),
      createdAt: at,
      updatedAt: at,
    },
    name: { status: "available" as const, value: `Asset ${index}` },
    symbol: { status: "available" as const, value: `A${index}` },
    classification: {
      kind: "classification_unavailable" as const,
      cause: {
        kind: "official_snapshot_unavailable" as const,
        storedRevision: null,
        reason: "source_unavailable" as const,
      },
    },
    amount: createAccountAssetAmount({ raw: String(index), decimals: "0", multiplier: null }),
    requiredStandards: requiredErc8056ObservationSchema.parse({
      asset,
      block,
      erc165: { standardId: "erc165", status: "not_supported" },
      erc8056: { standardId: "erc8056", status: "unknown" },
      pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: "unknown" },
    }),
  });
};

const collectionResult = (assets: readonly unknown[] = [contractAsset(1)]) => Object.freeze({
  account,
  block,
  viewRevision,
  native: {
    kind: "native" as const,
    asset: { kind: "native" as const, chainId },
    rawBalance: "7",
    classification: "native" as const,
  },
  assets,
  nextCursor: null,
});

const canonicalOutputSchema = (schema: z.ZodType): string => canonicalJsonStringify(
  JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io: "output",
  }))) as CanonicalJson,
);

describe("account asset contracts", () => {
  it("owns one collection contract and uses the token-catalog error registry", () => {
    expect(Object.keys(accountAssetApplicationContracts)).toEqual(["collection"]);
    const contract = accountAssetApplicationContracts.collection;
    expect(contract.applicationContract.errorRegistry).toBe(tokenCatalogErrorRegistry);
    expect(contract.contractVersion).toBe("1");
  });

  it("preserves the independent classification, asset, collection, and cursor schemas", () => {
    for (const [schema, expectedBytes, expectedDigest] of [
      [
        accountAssetClassificationSchema,
        6_007,
        "ef81c01a614f6fd36d92057b9fc223e3c4a109a3a8450be5c8b790221be8bf7e",
      ],
      [
        contractAccountAssetSchema,
        12_278,
        "e15f673ac41fac30f1d966ba807fde8f0656b734570be2c816ac02b23700188b",
      ],
      [
        accountAssetApplicationContracts.collection.successSchema,
        19_137,
        "340b0e8fac70eb66f59f0606a1496fda6f954eba42d49a5dc47fb8e294bbb74f",
      ],
      [
        accountAssetCursorSchema,
        3_736,
        "b71b68a8e68ac43357023b0cb56122b3c4d5c63e08c15f7e6877de6dfb2a790e",
      ],
    ] as const) {
      const canonical = canonicalOutputSchema(schema);
      expect(Buffer.byteLength(canonical, "utf8")).toBe(expectedBytes);
      expect(createHash("sha256").update(canonical, "utf8").digest("hex"))
        .toBe(expectedDigest);
    }
  });

  it("rejects foreign Official Asset evidence and fixed StockFactory identity", () => {
    const item = contractAsset(1);
    const snapshot = {
      sourceUri: officialAssetSourceDefinition.sourceUri,
      sourceObservedAt: at,
      rawResponseDigest: `0x${"01".repeat(32)}`,
      memberSetDigest: `0x${"02".repeat(32)}`,
      candidateListDigest: `0x${"03".repeat(32)}`,
      revision: Buffer.alloc(16, 4).toString("base64url"),
    };
    const official = {
      kind: "robinhood_stock_token" as const,
      snapshot,
      member: {
        assetUid: `0x${"04".repeat(32)}`,
        contractAddress: item.selection.asset.address,
        sourceName: "Asset 1",
        sourceSymbol: "A1",
      },
      verification: {
        assetUid: `0x${"04".repeat(32)}`,
        contractAddress: item.selection.asset.address,
        block,
        proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
        proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
        implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
        implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
        tokenCodeHash: `0x${"05".repeat(32)}`,
      },
    };
    expect(accountAssetClassificationSchema.parse(official)).toEqual(official);
    for (const member of [
      { ...official.member, assetUid: `0x${"07".repeat(32)}` },
      { ...official.member, contractAddress: contractAsset(2).selection.asset.address },
    ]) expect(() => accountAssetClassificationSchema.parse({ ...official, member }))
      .toThrow("Official asset verification identity differs.");
    const foreignAddress = contractAsset(2).selection.asset.address;
    const foreignMember = { ...official.member, contractAddress: foreignAddress };
    const foreignVerified = accountAssetClassificationSchema.parse({
      ...official, member: foreignMember,
      verification: { ...official.verification, contractAddress: foreignAddress },
    });
    const foreignUnavailable = accountAssetClassificationSchema.parse({
      kind: "classification_unavailable", cause: {
        kind: "stock_factory_verification_unavailable", snapshot, member: foreignMember,
        reason: "source_unavailable",
      },
    });
    for (const classification of [foreignVerified, foreignUnavailable]) {
      expect(() => contractAccountAssetSchema.parse({ ...item, classification }))
        .toThrow("Account asset selection and observation differ.");
    }
    expect(() => accountAssetClassificationSchema.parse({
      ...official,
      snapshot: { ...snapshot, sourceUri: "https://example.invalid/assets" },
    })).toThrow();
    expect(() => accountAssetClassificationSchema.parse({
      ...official,
      verification: {
        ...official.verification,
        proxyAddress: parseEvmAddressInput(`0x${"06".repeat(20)}`),
      },
    })).toThrow();
  });

  it("binds every current classification to one Official Asset snapshot", () => {
    const first = contractAsset(1);
    const second = contractAsset(2);
    const snapshot = {
      sourceUri: officialAssetSourceDefinition.sourceUri,
      sourceObservedAt: at,
      rawResponseDigest: `0x${"11".repeat(32)}`,
      memberSetDigest: `0x${"12".repeat(32)}`,
      candidateListDigest: `0x${"13".repeat(32)}`,
      revision: Buffer.alloc(16, 5).toString("base64url"),
    };
    const classified = (item: ReturnType<typeof contractAsset>, byte: string) => ({
      ...item,
      classification: {
        kind: "robinhood_stock_token" as const,
        snapshot,
        member: {
          assetUid: `0x${byte.repeat(32)}`,
          contractAddress: item.selection.asset.address,
          sourceName: item.name.status === "available" ? item.name.value : null,
          sourceSymbol: item.symbol.status === "available" ? item.symbol.value : null,
        },
        verification: {
          assetUid: `0x${byte.repeat(32)}`,
          contractAddress: item.selection.asset.address,
          block,
          proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
          proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
          implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
          implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
          tokenCodeHash: `0x${"15".repeat(32)}`,
        },
      },
    });
    const firstClassified = classified(first, "21");
    const secondClassified = classified(second, "22");
    const currentRevision = {
      account,
      officialSnapshotStatus: "current" as const,
      officialSnapshotRevision: snapshot.revision,
      selectionSetRevision,
    };
    const value = {
      ...collectionResult([firstClassified, secondClassified]),
      viewRevision: currentRevision,
    };
    expect(accountAssetApplicationContracts.collection.parsePublicSuccess(
      { account: target, limit: 5, cursor: null },
      value,
    ).assets).toHaveLength(2);
    const differentSnapshot = { ...snapshot, revision: Buffer.alloc(16, 9).toString("base64url") };
    for (const classification of [
      { ...firstClassified.classification, snapshot: differentSnapshot },
      { ...firstClassified.classification, verification: {
        ...firstClassified.classification.verification, block: { ...block, blockNumber: "43" },
      } },
      { kind: "custom_erc20", snapshot: differentSnapshot },
      { kind: "classification_unavailable", cause: {
        kind: "stock_factory_verification_unavailable", snapshot: differentSnapshot,
        member: firstClassified.classification.member, reason: "source_unavailable",
      } },
    ]) {
      const entry = contractAccountAssetSchema.parse({ ...firstClassified, classification });
      expect(() => accountAssetApplicationContracts.collection.successSchema.parse({
        ...value, assets: [entry],
      })).toThrow("Account asset collection identities differ.");
    }
    expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
      { account: target, limit: 5, cursor: null },
      {
        ...value,
        assets: [firstClassified, {
          ...secondClassified,
          classification: {
            ...secondClassified.classification,
            snapshot: {
              ...secondClassified.classification.snapshot,
              rawResponseDigest: `0x${"ff".repeat(32)}`,
            },
          },
        }],
      },
    )).toThrow();
  });

  it("owns the independent default and maximum page size of five", () => {
    expect(accountAssetLimits).toEqual({ defaultPageSize: 5, maximumPageSize: 5 });
    expect(accountAssetApplicationContracts.collection.parseInput({ account: target })).toEqual({
      account: target,
      limit: 5,
      cursor: null,
    });
    expect(() => accountAssetApplicationContracts.collection.parseInput({
      account: target,
      limit: 6,
    })).toThrow();
    expect(() => accountAssetApplicationContracts.collection.successSchema.parse(
      collectionResult(Array.from({ length: 6 }, (_, index) => contractAsset(index + 1))),
    )).toThrow();
  });


  it("owns collection account relations without adjacent cursor or selection rejection", () => {
    const contract = accountAssetApplicationContracts.collection;
    const request = contract.parseInput({ account: target, limit: 1 });
    const admitted = contract.parsePublicSuccess(request, collectionResult([]));
    const otherChain = parseEvmChainId("eip155:1");
    const variants = [
      ["view address", { ...admitted, viewRevision: {
        ...admitted.viewRevision, account: { ...account, address: foreignAccountAddress },
      } }],
      ["view chain", { ...admitted, viewRevision: {
        ...admitted.viewRevision, account: { ...account, chainId: otherChain },
      } }],
      ["block chain", { ...admitted, block: { ...admitted.block, chainId: otherChain } }],
      ["native chain", { ...admitted, native: {
        ...admitted.native, asset: { ...admitted.native.asset, chainId: otherChain },
      } }],
    ] as const;
    for (const [relation, value] of variants) {
      expect(() => contract.parsePublicSuccess(request, value), relation)
        .toThrow("Account asset collection identities differ.");
    }
    const foreignRequest = contract.parseInput({
      account: { kind: "address", address: foreignAccountAddress }, limit: 1,
    });
    expect(() => contract.parsePublicSuccess(foreignRequest, admitted))
      .toThrow("Account asset collection does not match its request.");
  });

  it("owns selection account agreement independently of view and request agreement", () => {
    const contract = accountAssetApplicationContracts.collection;
    const request = contract.parseInput({ account: target, limit: 1 });
    const admitted = contract.parsePublicSuccess(request, collectionResult());
    const entry = admitted.assets[0]!;
    const foreignEntry = contractAccountAssetSchema.parse({
      ...entry, selection: {
        ...entry.selection, account: { ...account, address: foreignAccountAddress },
      },
    });
    expect(() => contract.parsePublicSuccess(request, { ...admitted, assets: [foreignEntry] }))
      .toThrow("Account asset collection identities differ.");
  });

  it("binds every independent cursor revision component at input and output admission", () => {
    const contract = accountAssetApplicationContracts.collection;
    const request = contract.parseInput({ account: target, limit: 1 });
    const officialRevision = Buffer.alloc(16, 6).toString("base64url");
    const revision = { ...viewRevision, officialSnapshotRevision: officialRevision };
    const entry = contractAsset(2);
    const admitted = contract.parsePublicSuccess(request, {
      ...collectionResult([{
        ...entry,
        classification: { ...entry.classification, cause: {
          ...entry.classification.cause, storedRevision: officialRevision,
        } },
      }]),
      viewRevision: revision,
      nextCursor: { ...revision, group: "other", address: entry.selection.asset.address },
    });
    if (admitted.nextCursor === null) throw new TypeError("Cursor relation fixture is incomplete.");
    const cursor = admitted.nextCursor;
    const validContinuation = contract.parseInput({
      account: target, limit: 1,
      cursor: { ...cursor, address: contractAsset(1).selection.asset.address },
    });
    expect(contract.parsePublicSuccess(validContinuation, admitted)).toEqual(admitted);
    const variants = [
      ["account address", { ...cursor, account: { ...account, address: foreignAccountAddress } }],
      ["account chain", { ...cursor, account: { ...account, chainId: parseEvmChainId("eip155:1") } }],
      ["official revision", { ...cursor, officialSnapshotRevision: Buffer.alloc(16, 7).toString("base64url") }],
      ["selection revision", { ...cursor, selectionSetRevision: Buffer.alloc(16, 8).toString("base64url") }],
      ["unavailable reason", { ...cursor, officialSnapshotUnavailableReason: "rate_limited" }],
      ["official status", {
        account, officialSnapshotStatus: "current", officialSnapshotRevision: officialRevision,
        selectionSetRevision, group: "other", address: entry.selection.asset.address,
      }],
    ] as const;
    for (const [relation, value] of variants) {
      const changed = accountAssetCursorSchema.parse(value);
      expect(() => contract.parsePublicSuccess(request, { ...admitted, nextCursor: changed }), relation)
        .toThrow("Account asset collection identities differ.");
      const continuation = contract.parseInput({
        account: target, limit: 1,
        cursor: { ...changed, address: contractAsset(1).selection.asset.address },
      });
      expect(() => contract.parsePublicSuccess(continuation, admitted), relation)
        .toThrow("Account asset collection does not match its request.");
    }
  });

  it("keeps target failures explicit without the removed session-specific alias", () => {
    expect(accountAssetApplicationContracts.collection.failureCodes).toContain("wallet_not_connected");
    expect(accountAssetApplicationContracts.collection.failureCodes).toContain("runtime_state_unavailable");
    expect(accountAssetApplicationContracts.collection.failureCodes).not.toContain("wallet_session_unusable");
  });

  it("preserves exact decimal amount construction for collection assets", () => {
    expect(createAccountAssetAmount({ raw: "1234500", decimals: "6", multiplier: null }))
      .toEqual({
        raw: "1234500",
        decimals: "6",
        formattedRaw: "1.2345",
        uiAdjusted: null,
        formattedUiAdjusted: null,
      });
  });

  it("separates requested count from capacity and continuation fullness", () => {
    const contract = accountAssetApplicationContracts.collection;
    const two = collectionResult([contractAsset(1), contractAsset(2)]);
    expect(contract.successSchema.parse(two)).toEqual(two);
    expect(() => contract.parsePublicSuccess({ account: target, limit: 1, cursor: null }, two))
      .toThrow("Account asset collection does not match its request.");
    const continued = {
      ...collectionResult(), nextCursor: {
        ...viewRevision, group: "other", address: contractAsset(1).selection.asset.address,
      },
    };
    expect(contract.successSchema.parse(continued)).toEqual(continued);
    expect(contract.parsePublicSuccess({ account: target, limit: 1, cursor: null }, continued))
      .toEqual(continued);
    expect(() => contract.parsePublicSuccess({ account: target, limit: 3, cursor: null }, continued))
      .toThrow("Account asset collection does not match its request.");
    expect(contract.parsePublicSuccess({ account: target, limit: 3, cursor: null }, collectionResult()))
      .toEqual(collectionResult());
  });

  it("admits only unique default-first positions in both groups", () => {
    const first = contractAsset(1, defaultStockTokenManifest.assets[0]!.contractAddress);
    const last = contractAsset(2, defaultStockTokenManifest.assets[4]!.contractAddress);
    const low = contractAsset(3);
    const high = contractAsset(4, `0x${"ff".repeat(20)}`);
    const schema = accountAssetApplicationContracts.collection.successSchema;
    const valid = collectionResult([first, last, low, high]);
    expect(schema.parse(valid)).toEqual(valid);
    for (const entries of [
      [last, first], [low, first], [high, low], [first, first], [low, low],
    ]) {
      for (const entry of entries) expect(contractAccountAssetSchema.parse(entry)).toEqual(entry);
      expect(() => schema.parse(collectionResult(entries)))
        .toThrow("Account asset collection identities differ.");
    }
  });

  it("binds cursor group and rank to its address independently of the last-address relation", () => {
    const contract = accountAssetApplicationContracts.collection;
    const request = { account: target, limit: 1, cursor: null };
    const defaultEntry = contractAsset(1, defaultStockTokenManifest.assets[0]!.contractAddress);
    const other = contractAsset(2);
    for (const [entry, validPosition, invalidPositions] of [
      [defaultEntry, { group: "default", rank: 0 }, [{ group: "default", rank: 4 }, { group: "other" }]],
      [other, { group: "other" }, [{ group: "default", rank: 0 }]],
    ] as const) {
      const value = collectionResult([entry]);
      const cursor = { ...viewRevision, address: entry.selection.asset.address, ...validPosition };
      expect(contract.parsePublicSuccess(request, { ...value, nextCursor: cursor }).nextCursor).toEqual(cursor);
      for (const position of invalidPositions) {
        const invalid = accountAssetCursorSchema.parse({
          ...viewRevision, address: entry.selection.asset.address, ...position,
        });
        expect(() => contract.successSchema.parse({ ...value, nextCursor: invalid }))
          .toThrow("Account asset collection identities differ.");
        // Empty terminal output isolates input-position validation from progress checks.
        const input = contract.parseInput({ account: target, limit: 1, cursor: invalid });
        expect(() => contract.parsePublicSuccess(input, collectionResult([])))
          .toThrow("Account asset collection does not match its request.");
      }
    }
    const value = collectionResult([other]);
    const anotherAddress = contractAsset(3).selection.asset.address;
    expect(() => contract.successSchema.parse({
      ...value, nextCursor: { ...viewRevision, group: "other", address: anotherAddress },
    })).toThrow("Account asset collection identities differ.");
    expect(() => contract.successSchema.parse({
      ...collectionResult([]), nextCursor: { ...viewRevision, group: "other", address: anotherAddress },
    })).toThrow("Account asset collection identities differ.");
  });

  it("requires progress in manifest order and then address order", () => {
    const contract = accountAssetApplicationContracts.collection;
    const first = contractAsset(1, defaultStockTokenManifest.assets[0]!.contractAddress);
    const later = contractAsset(2, defaultStockTokenManifest.assets[4]!.contractAddress);
    const low = contractAsset(3);
    const high = contractAsset(4);
    for (const [cursor, after, beforeOrEqual] of [
      [{ ...viewRevision, group: "default", rank: 0, address: first.selection.asset.address }, later, first],
      [{ ...viewRevision, group: "other", address: low.selection.asset.address }, high, later],
      [{ ...viewRevision, group: "other", address: low.selection.asset.address }, high, low],
    ] as const) {
      const input = contract.parseInput({ account: target, limit: 1, cursor });
      expect(contract.parsePublicSuccess(input, collectionResult([after])).assets).toEqual([after]);
      const nonAdvancing = contract.successSchema.parse(collectionResult([beforeOrEqual]));
      expect(() => contract.parsePublicSuccess(input, nonAdvancing))
        .toThrow("Account asset collection does not match its request.");
    }
  });

  it("bounds raw balances and binds each adjustment variant to the reported raw value", () => {
    const maximum = (1n << 256n) - 1n;
    const amount = { raw: "0", decimals: null, formattedRaw: null, uiAdjusted: null, formattedUiAdjusted: null };
    for (const raw of ["0", maximum.toString()]) {
      expect(accountAssetAmountSchema.parse({ ...amount, raw }).raw).toBe(raw);
      expect(nativeAccountAssetSchema.parse({ ...collectionResult().native, rawBalance: raw }).rawBalance)
        .toBe(raw);
    }
    const over = (maximum + 1n).toString();
    expect(() => accountAssetAmountSchema.parse({ ...amount, raw: over })).toThrow("uint256");
    expect(() => nativeAccountAssetSchema.parse({ ...collectionResult().native, rawBalance: over }))
      .toThrow("uint256");
    for (const [uiAdjusted, foreignRaw] of [
      [calculateScaledUiAmount("2", "1000000000000000000"), "1"],
      [calculateScaledUiAmount(maximum.toString(), maximum.toString()), (maximum - 1n).toString()],
    ] as const) {
      expect(accountAssetAmountSchema.parse({ ...amount, raw: uiAdjusted.raw, uiAdjusted }).uiAdjusted)
        .toEqual(uiAdjusted);
      expect(() => accountAssetAmountSchema.parse({ ...amount, raw: foreignRaw, uiAdjusted }))
        .toThrow("Account asset adjustment uses a different raw balance.");
    }
    const formatted = createAccountAssetAmount({ raw: "1234500", decimals: "6", multiplier: "1000000000000000000" });
    for (const field of ["formattedRaw", "formattedUiAdjusted"] as const) {
      expect(() => accountAssetAmountSchema.parse({ ...formatted, [field]: "9" }))
        .toThrow("Account asset amount formatting is inconsistent.");
    }
  });

  it("binds entry inclusion and standard identity without aggregate rejection", () => {
    const entry = contractAsset(1);
    expect(contractAccountAssetSchema.parse(entry)).toEqual(entry);
    expect(() => contractAccountAssetSchema.parse({
      ...entry, selection: { ...entry.selection, included: false },
    })).toThrow("Account asset selection and observation differ.");
    const otherChain = parseEvmChainId("eip155:1");
    for (const observation of [
      { ...entry.requiredStandards, asset: { ...entry.requiredStandards.asset, address: contractAsset(2).selection.asset.address } },
      { ...entry.requiredStandards, asset: { ...entry.requiredStandards.asset, chainId: otherChain },
        block: { ...block, chainId: otherChain } },
    ]) {
      const admitted = requiredErc8056ObservationSchema.parse(observation);
      expect(() => contractAccountAssetSchema.parse({ ...entry, requiredStandards: admitted }))
        .toThrow("Account asset selection and observation differ.");
    }
    const laterObservation = requiredErc8056ObservationSchema.parse({
      ...entry.requiredStandards, block: { ...block, blockNumber: "43" },
    });
    const validEntry = contractAccountAssetSchema.parse({ ...entry, requiredStandards: laterObservation });
    expect(() => accountAssetApplicationContracts.collection.successSchema.parse(collectionResult([validEntry])))
      .toThrow("Account asset collection identities differ.");
    const differentReason = contractAccountAssetSchema.parse({ ...entry, classification: {
      ...entry.classification, cause: { ...entry.classification.cause, reason: "rate_limited" },
    } });
    expect(() => accountAssetApplicationContracts.collection.successSchema.parse(collectionResult([differentReason])))
      .toThrow("Account asset collection identities differ.");
  });

  it("requires an adjustment exactly when a current multiplier was observed and binds its value", () => {
    const entry = contractAsset(1);
    const requiredStandards = requiredErc8056ObservationSchema.parse({
      ...entry.requiredStandards,
      erc165: { standardId: "erc165", status: "supported" },
      erc8056: { standardId: "erc8056", status: "supported" },
      pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: "supported" },
      values: { currentMultiplier: "2000000000000000000", pendingMultiplier: "0", pendingEffectiveAt: "0" },
    });
    const amount = createAccountAssetAmount({ raw: "1", decimals: "0", multiplier: "2000000000000000000" });
    expect(contractAccountAssetSchema.parse({ ...entry, requiredStandards, amount }).amount).toEqual(amount);
    for (const invalid of [
      { ...entry, requiredStandards },
      { ...entry, amount },
      { ...entry, requiredStandards, amount: createAccountAssetAmount({ raw: "1", decimals: "0", multiplier: "3000000000000000000" }) },
    ]) expect(() => contractAccountAssetSchema.parse(invalid))
      .toThrow("Account asset amount and multiplier differ.");
  });
});
