import { parseTokenSelectionReview, tokenSelectionReviewDigest } from "../../src/token-catalog/contract-schema.js";

export const tokenReviewFixture = (options: Readonly<{
  kind?: "add" | "remove";
  classification?: "official" | "unlisted";
  missingMetadata?: boolean;
  createdAt?: string;
}> = {}) => {
  const kind = options.kind ?? "add";
  const chainId = "eip155:4663";
  const account = { chainId, address: `0x${"34".repeat(20)}` };
  const asset = { kind: "erc20", chainId, address: `0x${"12".repeat(20)}` };
  const createdAt = options.createdAt ?? "2026-07-18T00:00:03.000Z";
  const block = { chainId, blockNumber: "42", blockHash: `0x${"ab".repeat(32)}`, blockTimestamp: "2026-07-18T00:00:00.000Z" };
  const revision = Buffer.alloc(16, 3).toString("base64url");
  const base = { contractVersion: "1", domain: "token_selection", operationId: Buffer.alloc(32, 21).toString("base64url"),
    kind, createdAt, actionExpiresAt: new Date(Date.parse(createdAt) + 300_000).toISOString(), target: { account, asset },
    precondition: { accountTarget: { kind: "address" },
      previousSelection: kind === "add" ? null : { account, asset, included: true, revision, createdAt, updatedAt: createdAt },
      selectionSetRevision: kind === "add" ? null : revision },
    ...(kind === "remove" ? { decision: { action: "remove_selection" }, fixedEvidence: {} } : {
      decision: { name: options.missingMetadata ? { status: "unavailable", reason: "unsafe_text" } : { status: "available", value: "Example Token" },
        symbol: { status: "available", value: "TOK" }, officialClassification: options.classification ?? "unlisted", warningCodes: ["partial_result"] },
      fixedEvidence: { inspectionBlock: block, officialSnapshotRevision: revision,
        officialEvidence: options.classification === "official" ? { assetUid: `0x${"cd".repeat(32)}`, snapshotRevision: revision, verificationBlock: block } : null },
    }),
  };
  return parseTokenSelectionReview({ ...base, reviewDigest: tokenSelectionReviewDigest(base) });
};
