import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";

import {
  canonicalBlockReference,
  ChainRpcError,
  type ChainRpcMethod,
  type ChainRpcRequestMap,
  type RpcRequester,
} from "../../src/chain/rpc.js";
import {parseEvmAddress} from "../../src/evm/identities.js";
import {parseHash32, parseUtcTimestamp} from "../../src/core/index.js";
import {productChainId} from "../../src/registry/client.js";
import {type ChainAnchor} from "../../src/evm/primitives.js";
import {
  createStockFactoryVerifier,
} from "../../src/registry/index.js";
import {
  assertOfficialAssetSourceSnapshot,
  officialAssetCandidateListDigest,
  officialAssetMemberSetDigest,
  officialAssetSourceDefinition,
  stockFactoryAdmissionManifest,
} from "../../src/registry/official-asset-contract.js";
import {
  stockFactoryImplementationCodeFixture,
  stockFactoryProxyCodeFixture,
} from "./stock-factory-fixture.js";

const blockHash = parseHash32(`0x${"a".repeat(64)}`);
const expectedProxyAddress = parseEvmAddress("0x4783c67b63de2b358ac5951a7d41f47a38f3c046");
const expectedImplementationAddress = parseEvmAddress("0xee351e53bce6aaf106428358838197c91e36ee0e");
const expectedImplementationSlot = parseHash32(
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
);
const expectedProxyCodeHash = parseHash32(
  "0x394c3517e9331e7c88ef8af388c0cb63c720af1b1b4d5a5cace212f7df0b045a",
);
const expectedImplementationCodeHash = parseHash32(
  "0x3bfd5841605b9931c9dbb0f9f54a28b4038918ceb74d6d1081bc7f963fe528b4",
);
const block: ChainAnchor = {
  chainId: "eip155:4663" as ChainAnchor["chainId"],
  blockNumber: "14737111" as ChainAnchor["blockNumber"],
  blockHash,
  blockTimestamp: "2026-07-20T13:28:38.000Z" as ChainAnchor["blockTimestamp"],
};
const reference = canonicalBlockReference(blockHash);
const uid = parseHash32(`0x${"1".repeat(64)}`);
const token = parseEvmAddress(`0x${"2".repeat(40)}`);
const mappedAddressWord = `0x${"0".repeat(24)}${token.slice(2)}`;
const implementationWord = `0x${"0".repeat(24)}${expectedImplementationAddress.slice(2)}`;

class FactoryRpc implements RpcRequester {
  readonly calls: Array<Readonly<{ method: ChainRpcMethod; params: readonly unknown[] }>> = [];
  proxyCode: unknown = stockFactoryProxyCodeFixture;
  implementationCode: unknown = stockFactoryImplementationCodeFixture;
  implementationStorage: unknown = implementationWord;
  tokenCode: unknown = "0x01";
  mappedAddress: unknown = mappedAddressWord;

  async request<Method extends ChainRpcMethod>(
    method: Method,
    params: ChainRpcRequestMap[Method],
    _signal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "eth_getStorageAt") return this.implementationStorage;
    if (method === "eth_call") return this.mappedAddress;
    if (method !== "eth_getCode") throw new Error("Unexpected RPC method.");
    const address = params[0];
    if (address === expectedProxyAddress) return this.proxyCode;
    if (address === expectedImplementationAddress) return this.implementationCode;
    if (address === token) return this.tokenCode;
    throw new Error("Unexpected code address.");
  }
}

const snapshotMembers = [{ assetUid: uid, contractAddress: token }];
const decodedSnapshot = assertOfficialAssetSourceSnapshot({
  sourceUri: officialAssetSourceDefinition.sourceUri,
  sourceObservedAt: parseUtcTimestamp("2026-07-20T13:28:38.000Z"),
  rawResponseDigest: parseHash32(`0x${"b".repeat(64)}`),
  memberSetDigest: officialAssetMemberSetDigest(snapshotMembers),
  candidateListDigest: officialAssetCandidateListDigest(snapshotMembers),
  chainId: productChainId,
  members: snapshotMembers,
});
const member = decodedSnapshot.members[0]!;

const readyVerifier = async (rpc: RpcRequester) => {
  const result = await createStockFactoryVerifier({
    rpc,
    block,
    stateReference: reference,
    signal: new AbortController().signal,
  });
  if (result.status !== "ready") {
    throw new Error(`Expected a ready verifier, received ${result.reason}.`);
  }
  return result.verifier;
};

describe("StockFactory verifier", () => {
  it("proves the pinned code hashes from independent raw bytecode fixtures", () => {
    const hash = (hex: string): string =>
      `0x${Buffer.from(keccak_256(Buffer.from(hex.slice(2), "hex"))).toString("hex")}`;
    expect(hash(stockFactoryProxyCodeFixture)).toBe(
      "0x394c3517e9331e7c88ef8af388c0cb63c720af1b1b4d5a5cace212f7df0b045a",
    );
    expect(hash(stockFactoryImplementationCodeFixture)).toBe(
      "0x3bfd5841605b9931c9dbb0f9f54a28b4038918ceb74d6d1081bc7f963fe528b4",
    );
  });

  it("shares pinned factory identity and verifies one exact decoded snapshot member", async () => {
    expect(stockFactoryAdmissionManifest.proxyAddress).toBe(expectedProxyAddress);
    expect(stockFactoryAdmissionManifest.implementationAddress).toBe(
      expectedImplementationAddress,
    );
    expect(stockFactoryAdmissionManifest.implementationSlot).toBe(
      expectedImplementationSlot,
    );
    expect(stockFactoryAdmissionManifest.proxyCodeHash).toBe(expectedProxyCodeHash);
    expect(stockFactoryAdmissionManifest.implementationCodeHash).toBe(
      expectedImplementationCodeHash,
    );
    const rpc = new FactoryRpc();
    const verifier = await readyVerifier(rpc);
    await expect(verifier.verify(member)).resolves.toEqual({
      status: "verified",
      member,
      verification: {
        assetUid: uid,
        contractAddress: token,
        block,
        proxyAddress: expectedProxyAddress,
        proxyCodeHash: expectedProxyCodeHash,
        implementationAddress: expectedImplementationAddress,
        implementationCodeHash: expectedImplementationCodeHash,
        tokenCodeHash: "0x5fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2",
      },
    });
    await verifier.verify(member);
    expect(rpc.calls.map((call) => call.method)).toEqual([
      "eth_getCode",
      "eth_getStorageAt",
      "eth_getCode",
      "eth_call",
      "eth_getCode",
      "eth_call",
      "eth_getCode",
    ]);
    expect(rpc.calls.filter((call) => call.method === "eth_getStorageAt")[0]?.params).toEqual([
      expectedProxyAddress,
      expectedImplementationSlot,
      reference,
    ]);
    expect(rpc.calls.filter((call) => call.method === "eth_call").map((call) => call.params)).toEqual([
      [{ to: expectedProxyAddress, data: `0x97bb3ce9${uid.slice(2)}` }, reference],
      [{ to: expectedProxyAddress, data: `0x97bb3ce9${uid.slice(2)}` }, reference],
    ]);
    expect(rpc.calls.filter((call) => call.method === "eth_getCode").map((call) => call.params)).toEqual([
      [expectedProxyAddress, reference],
      [expectedImplementationAddress, reference],
      [token, reference],
      [token, reference],
    ]);
  });

  it("rejects proxy, implementation, mapping, and token-code mismatches independently", async () => {
    for (const mutate of [
      (rpc: FactoryRpc) => { rpc.proxyCode = "0x01"; },
      (rpc: FactoryRpc) => { rpc.implementationStorage = `0x${"0".repeat(64)}`; },
      (rpc: FactoryRpc) => { rpc.implementationCode = "0x01"; },
    ]) {
      const rpc = new FactoryRpc();
      mutate(rpc);
      await expect(createStockFactoryVerifier({
        rpc, block, stateReference: reference, signal: new AbortController().signal,
      })).resolves.toEqual({
        status: "unavailable",
        reason: "factory_identity_mismatch",
      });
    }

    const wrongMapping = new FactoryRpc();
    wrongMapping.mappedAddress = `0x${"0".repeat(64)}`;
    const mappingVerifier = await readyVerifier(wrongMapping);
    await expect(mappingVerifier.verify(member)).resolves.toEqual({
      status: "unavailable",
      member,
      reason: "token_identity_mismatch",
    });
    expect(wrongMapping.calls.filter((call) =>
      call.method === "eth_getCode" && call.params[0] === token)).toHaveLength(0);

    const noCode = new FactoryRpc();
    noCode.tokenCode = "0x";
    const codeVerifier = await readyVerifier(noCode);
    await expect(codeVerifier.verify(member)).resolves.toEqual({
      status: "unavailable",
      member,
      reason: "token_code_missing",
    });
  });

  it("separates provider decode failures from local and whole-request failures", async () => {
    const malformed = new FactoryRpc();
    malformed.implementationStorage = "not-storage";
    await expect(createStockFactoryVerifier({
      rpc: malformed,
      block,
      stateReference: reference,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: "unavailable", reason: "source_inconsistent" });

    const wholeRequest = new ChainRpcError("runtime_busy");
    const busy = new FactoryRpc();
    busy.proxyCode = undefined;
    busy.request = async () => { throw wholeRequest; };
    await expect(createStockFactoryVerifier({
      rpc: busy,
      block,
      stateReference: reference,
      signal: new AbortController().signal,
    })).rejects.toBe(wholeRequest);

    const localFailure = new Error("local dependency failed");
    const local = new FactoryRpc();
    local.request = async () => { throw localFailure; };
    await expect(createStockFactoryVerifier({
      rpc: local,
      block,
      stateReference: reference,
      signal: new AbortController().signal,
    })).rejects.toBe(localFailure);
  });

  it("rejects a block label that does not match the exact RPC state reference", async () => {
    await expect(createStockFactoryVerifier({
      rpc: new FactoryRpc(),
      block,
      stateReference: canonicalBlockReference(parseHash32(`0x${"b".repeat(64)}`)),
      signal: new AbortController().signal,
    })).rejects.toThrow("block reference");
  });
});
