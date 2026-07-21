import { describe, expect, it } from "vitest";

import {
  accountAssetClassificationSchema,
  accountAssetViewRevisionSchema,
} from "../../src/account-assets/contracts.js";
import type { AccountAssetRowView } from "../../src/account-assets/view.js";
import {
  accountAssetAnchorFields,
  assetIdentityWarnings,
  classificationEvidenceFields,
  classificationLabel,
  officialSnapshotFresh,
  officialSnapshotStatusText,
} from "../../src/account-assets/view.js";
import {
  chainAnchorSchema,
  parseEvmAddressInput,
  parseEvmChainId,
  parseUtcTimestamp,
} from "../../src/core/index.js";
import { tokenSelectionSetRevisionSchema } from "../../src/token-catalog/index.js";

const chainId = parseEvmChainId("eip155:4663");
const at = parseUtcTimestamp("2026-07-21T00:00:00.000Z");
const hash = `0x${"ab".repeat(32)}`;
const address = parseEvmAddressInput(`0x${"12".repeat(20)}`);
const revision = Buffer.alloc(16, 1).toString("base64url");
const setRevision = tokenSelectionSetRevisionSchema.parse(Buffer.alloc(16, 2).toString("base64url"));
const block = chainAnchorSchema.parse({
  chainId,
  blockNumber: "42",
  blockHash: hash,
  blockTimestamp: at,
});
const snapshot = {
  sourceUri: "https://api.robinhood.com/rhj/assets",
  sourceObservedAt: at,
  rawResponseDigest: hash,
  memberSetDigest: hash,
  revision,
};

const stockToken = accountAssetClassificationSchema.parse({
  kind: "robinhood_stock_token",
  snapshot,
  member: { assetUid: hash, contractAddress: address, sourceName: "Apple Inc.", sourceSymbol: "AAPL" },
  verification: {
    assetUid: hash,
    contractAddress: address,
    block,
    proxyAddress: address,
    proxyCodeHash: hash,
    implementationAddress: address,
    implementationCodeHash: hash,
    tokenCodeHash: hash,
  },
});
const customErc20 = accountAssetClassificationSchema.parse({ kind: "custom_erc20", snapshot });
const unavailable = accountAssetClassificationSchema.parse({
  kind: "classification_unavailable",
  storedRevision: null,
  snapshot: null,
  member: null,
  reason: "token_code_missing",
});

const fieldValue = (
  fields: readonly Readonly<{ label: string; value: string }>[],
  label: string,
): string | undefined => fields.find((field) => field.label === label)?.value;

describe("account asset view evidence", () => {
  it("labels each classification kind from one source", () => {
    expect(classificationLabel(stockToken)).toBe("Robinhood Stock Token");
    expect(classificationLabel(customErc20)).toBe("Custom ERC-20");
    expect(classificationLabel(unavailable)).toBe("Classification unavailable");
  });

  it("exposes stock-token provenance and StockFactory verification identity", () => {
    const fields = classificationEvidenceFields(stockToken);
    expect(fieldValue(fields, "Source")).toBe("https://api.robinhood.com/rhj/assets");
    expect(fieldValue(fields, "Observed at")).toBe(at);
    expect(fieldValue(fields, "Snapshot revision")).toBe(revision);
    expect(fieldValue(fields, "Verified implementation")).toBe(address);
    expect(fieldValue(fields, "Implementation code hash")).toBe(hash);
    expect(fieldValue(fields, "Token code hash")).toBe(hash);
    expect(fieldValue(fields, "Verified at block")).toBe("42");
  });

  it("states the absence basis for a custom ERC-20", () => {
    const fields = classificationEvidenceFields(customErc20);
    expect(fieldValue(fields, "Source")).toBe("https://api.robinhood.com/rhj/assets");
    expect(fieldValue(fields, "Basis")).toContain("absent");
  });

  it("surfaces the reason when classification is unavailable", () => {
    const fields = classificationEvidenceFields(unavailable);
    expect(fields[0]?.label).toBe("Reason");
    expect(fields[0]?.value).toContain("No contract code");
    expect(fieldValue(fields, "Source")).toBeUndefined();
  });

  it("exposes the chain anchor including hash and time", () => {
    const fields = accountAssetAnchorFields(block);
    expect(fieldValue(fields, "Block")).toBe("42");
    expect(fieldValue(fields, "Block time")).toBe(at);
    expect(fieldValue(fields, "Block hash")).toBe(hash);
  });

  it("derives official-snapshot freshness from the view revision", () => {
    const current = accountAssetViewRevisionSchema.parse({
      officialSnapshotStatus: "current",
      officialSnapshotRevision: revision,
      selectionSetRevision: setRevision,
    });
    const stale = accountAssetViewRevisionSchema.parse({
      officialSnapshotStatus: "unavailable",
      officialSnapshotRevision: null,
      selectionSetRevision: null,
    });
    expect(officialSnapshotFresh(current)).toBe(true);
    expect(officialSnapshotStatusText(current)).toBe("Official data current");
    expect(officialSnapshotFresh(stale)).toBe(false);
    expect(officialSnapshotStatusText(stale)).toBe("Official data unavailable");
  });

  it("warns when an unsafe identity string is withheld", () => {
    const row = { nameIssue: "unsafe_text", symbolIssue: null } as AccountAssetRowView;
    const warnings = assetIdentityWarnings(row);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unsafe text");
    expect(assetIdentityWarnings({ nameIssue: null, symbolIssue: null } as AccountAssetRowView)).toHaveLength(0);
  });
});
