import { beforeAll, describe, expect, it } from "vitest";

import {
  accountAssetMetadataAuthority,
  accountAssetLimits,
  projectAccountAssetCollectionSuccess,
} from "../../src/account-assets/contracts.js";
import { createAccountAssetFailure } from "../../src/account-assets/errors.js";
import { projectAccountAssetEntry } from "../../src/account-assets/metadata.js";
import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import {
  accountBalanceCapability,
  canonicalJsonStringify,
  captureCanonicalJson,
  maximumEvmBalanceRaw,
  parseEvmAddress,
  sourceReferenceSchema,
  type SourceReference,
} from "../../src/core/index.js";
import { internalResponseLimitBytes } from "../../src/runtime/http-boundary.js";
import {
  tokenInspectionDigest,
  tokenRegistrationWithInspectionSchema,
} from "../../src/token-catalog/index.js";
import {
  ScriptedRpc,
  connectedWallet,
  createChainHandlerHarness,
  rpcFailure,
  rpcValue,
} from "../chain/handler-harness.js";
import {
  chainId,
  createInspectionSuccess,
  walletAddress,
} from "../token-catalog/harness.js";

let encoder: Erc20CallEncoder;
beforeAll(async () => { encoder = await createErc20CallEncoder(); });

const maximumPublicOrigin = (index: number): string => {
  const first = String.fromCharCode("a".charCodeAt(0) + index);
  const origin = `https://${first}${"a".repeat(4_079)}.example`;
  if (Buffer.byteLength(origin, "utf8") !== 4_096) throw new TypeError("Maximum public origin fixture is invalid.");
  return origin;
};

const configuredSource = (index: number): Readonly<{
  owner: "user_configured";
  reference: SourceReference;
}> => {
  const configurationDigest = Buffer.alloc(32, index).toString("base64url");
  return Object.freeze({
    owner: "user_configured" as const,
    reference: sourceReferenceSchema.parse({
      kind: "configured_rpc",
      sourceId: `rpc:${configurationDigest}`,
      publicOrigin: maximumPublicOrigin(index),
      configurationDigest,
    }),
  });
};

const maximumDisplayText = "😀".repeat(128);

const canonicalHttpResponseByteLength = (value: unknown): number => Buffer.byteLength(
  `${canonicalJsonStringify(captureCanonicalJson(value))}\n`,
  "utf8",
);

const storedRegistration = async (index: number) => {
  const address = parseEvmAddress(`0x${index.toString(16).padStart(2, "0").repeat(20)}`);
  const inspection = await createInspectionSuccess({
    asset: { kind: "erc20", chainId, address },
    block: { kind: "latest" },
  }, {
    chainRpc: configuredSource(index),
    name: maximumDisplayText,
    symbol: maximumDisplayText,
  });
  return tokenRegistrationWithInspectionSchema.parse({
    registration: {
      account: { chainId, address: walletAddress },
      asset: inspection.data.asset,
      revision: Buffer.alloc(16, index).toString("base64url"),
      inspectionDigest: tokenInspectionDigest(inspection),
      createdAt: "2026-07-18T00:00:03.000Z",
    },
    inspection,
  });
};

export const verifyMaximumAccountAssetEnvelope = async (): Promise<number> => {
  const stored = await Promise.all(
    Array.from({ length: accountAssetLimits.maximumPageSize }, (_, index) => storedRegistration(index + 1)),
  );
  const block = {
    number: "0x2a",
    hash: `0x${"88".repeat(32)}`,
    timestamp: "0x65a00000",
    transactions: [],
  };
  const maximumQuantity = `0x${"f".repeat(64)}`;
  const chain = createChainHandlerHarness({
    rpc: new ScriptedRpc([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block),
      rpcValue("eth_getBalance", maximumQuantity),
      ...stored.map(() => rpcValue("eth_call", maximumQuantity)),
      ...stored.map(() => rpcFailure("eth_call", "source_unavailable")),
    ]),
    encoder,
    wallet: connectedWallet(walletAddress),
    chainRpc: configuredSource(6),
  });
  try {
    const balance = await chain.invoke(accountBalanceCapability, {
      account: { kind: "address", address: walletAddress },
      includeNative: true,
      tokens: stored.map((entry) => entry.registration.asset.address),
      block: { kind: "latest" },
    });
    if (!balance.ok) throw new TypeError(balance.error.code);
    if (balance.data.native.status !== "available" ||
      balance.data.native.amount.raw !== maximumEvmBalanceRaw ||
      balance.data.tokens.some((token) =>
        token.result.status !== "available" || token.result.amount.raw !== maximumEvmBalanceRaw)) {
      throw new TypeError("Maximum balance fixture is invalid.");
    }
    if (
      balance.evidence.sources.length !== 14 ||
      balance.evidence.conclusions.length !== 7 ||
      balance.warnings.length !== 6
    ) throw new TypeError("Maximum balance evidence fixture is invalid.");
    const result = projectAccountAssetCollectionSuccess({
      account: stored[0]!.registration.account,
      metadataAuthority: accountAssetMetadataAuthority,
      assets: stored.map(projectAccountAssetEntry),
      nextCursor: stored.at(-1)!.registration.asset.address,
      balance: { status: "available", snapshot: balance },
    });
    if (result.sourceReferences.length !== 7 || result.assets.length !== 5) {
      throw new TypeError("Maximum source-reference fixture is invalid.");
    }
    const availableByteLength = canonicalHttpResponseByteLength(result);
    const unavailableResult = projectAccountAssetCollectionSuccess({
      account: stored[0]!.registration.account,
      metadataAuthority: accountAssetMetadataAuthority,
      assets: stored.map(projectAccountAssetEntry),
      nextCursor: stored.at(-1)!.registration.asset.address,
      balance: {
        status: "unavailable",
        failure: createAccountAssetFailure("source_unavailable"),
      },
    });
    if (unavailableResult.sourceReferences.length !== 5) {
      throw new TypeError("Maximum unavailable source-reference fixture is invalid.");
    }
    const unavailableByteLength = canonicalHttpResponseByteLength(unavailableResult);
    const byteLength = Math.max(availableByteLength, unavailableByteLength);
    if (byteLength > internalResponseLimitBytes) {
      throw new TypeError("Maximum account asset response exceeds the HTTP boundary.");
    }
    return byteLength;
  } finally {
    await chain.close();
  }
};

describe("account asset response boundary", () => {
  it("keeps the maximum production-shaped five-asset response inside the fixed HTTP limit", async () => {
    const byteLength = await verifyMaximumAccountAssetEnvelope();
    expect(byteLength).toBeLessThanOrEqual(internalResponseLimitBytes);
  });
});
