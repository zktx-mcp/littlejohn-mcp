import { accountAssetApplicationContracts, createAccountAssetAmount } from "../../src/account-assets/contracts.js";

// Independent input dimensions. Expected human values belong to the consumer
// tests, not to the formatter or this canonical fixture.
export const accountAssetsPresentationFixture = (options: Readonly<{
  raw?: string;
  decimals?: string | null;
  adjustment?: "supported" | "not_supported" | "unknown" | "inconsistent";
  multiplier?: string;
  pendingMultiplier?: string;
}> = {}) => {
  const chainId = "eip155:4663";
  const at = "2026-07-21T00:00:00.000Z";
  const account = { chainId, address: `0x${"34".repeat(20)}` };
  const asset = { kind: "erc20", chainId, address: `0x${"12".repeat(20)}` };
  const input = { account: { kind: "address", address: account.address } };
  const block = { chainId, blockNumber: "42", blockHash: `0x${"ab".repeat(32)}`, blockTimestamp: at };
  const adjustment = options.adjustment ?? "supported";
  const multiplier = adjustment === "supported" ? options.multiplier ?? "2000000000000000000" : null;
  const result = accountAssetApplicationContracts.collection.parsePublicSuccess(
    accountAssetApplicationContracts.collection.parseInput(input), {
      account, block,
      viewRevision: { account, officialSnapshotStatus: "unavailable", officialSnapshotRevision: null,
        officialSnapshotUnavailableReason: "source_unavailable", selectionSetRevision: null },
      native: { kind: "native", asset: { kind: "native", chainId }, rawBalance: "7", classification: "native" },
      assets: [{ kind: "erc20",
        selection: { account, asset, included: true, revision: Buffer.alloc(16, 3).toString("base64url"), createdAt: at, updatedAt: at },
        name: { status: "available", value: "Example Token" }, symbol: { status: "available", value: "TOK" },
        classification: { kind: "classification_unavailable", cause: { kind: "official_snapshot_unavailable", storedRevision: null, reason: "source_unavailable" } },
        amount: createAccountAssetAmount({ raw: options.raw ?? "1000000", decimals: options.decimals === undefined ? "6" : options.decimals, multiplier }),
        requiredStandards: { asset, block, erc165: { standardId: "erc165", status: "supported" },
          erc8056: { standardId: "erc8056", status: adjustment },
          pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: adjustment },
          ...(multiplier === null ? {} : { values: { currentMultiplier: multiplier,
            pendingMultiplier: options.pendingMultiplier ?? "3000000000000000000", pendingEffectiveAt: "1900000000" } }),
        },
      }], nextCursor: null,
    },
  );
  return { input, result };
};
