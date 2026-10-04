import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {admitDynamicFeeTransactionRequest, dynamicFeeRequestCommitment} from "../../src/evm/transaction-request.js";

const from = `0x${"1".repeat(40)}`;
const to = `0x${"2".repeat(40)}`;
const request = {
  type: "2", accessList: [], chainId: "eip155:4663", from, to,
  value: "0", data: "0x", nonce: "0", gasLimit: "21000",
  maxFeePerGas: "5", maxPriorityFeePerGas: "2",
};

describe("dynamic-fee request commitment", () => {
  it("matches an independently encoded canonical request vector", () => {
    const text = `{"digestKind":"wallet_request","digestVersion":"1","request":{"accessList":[],"chainId":"eip155:4663","data":"0x","from":"${from}","gasLimit":"21000","maxFeePerGas":"5","maxPriorityFeePerGas":"2","nonce":"0","to":"${to}","type":"2","value":"0"}}`;
    expect(dynamicFeeRequestCommitment(request)).toBe(`0x${createHash("sha256").update(text).digest("hex")}`);
    for (const changed of [
      { chainId: "eip155:1" }, { from: to }, { to: from }, { value: "1" },
      { data: "0x00" }, { nonce: "1" }, { gasLimit: "21001" },
      { maxFeePerGas: "6" }, { maxPriorityFeePerGas: "3" },
    ]) expect(dynamicFeeRequestCommitment({ ...request, ...changed })).not.toBe(dynamicFeeRequestCommitment(request));
  });

  it("rejects unsupported envelope fields and invalid fee bounds", () => {
    for (const changed of [
      { type: "0" }, { gasLimit: "0" }, { maxPriorityFeePerGas: "6" },
      { data: "0x0" }, { nonce: "01" }, { accessList: [{ address: to, storageKeys: [] }] },
      { gasPrice: "5" }, { maxFeePerGas: (1n << 256n).toString() },
    ]) expect(() => admitDynamicFeeTransactionRequest({ ...request, ...changed })).toThrow();
  });
});
