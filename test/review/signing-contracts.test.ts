import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSigningCodec } from "../../src/chain/evm-standard.js";
import {createCanonicalClock, parseHash32} from "../../src/core/index.js";
import {evmAccountIdentitySchema} from "../../src/evm/identities.js";
import {keccak256FromHex} from "../../src/evm/keccak256.js";
import { verifyDataSignature } from "../../src/intelligence/signature-verification.js";
import { admitSigningPayload, signingPayloadSchema, signingTypedDataValues, type TypedSigningPayload } from "../../src/review/signing-payload.js";
import { hashSigningPayload } from "../../src/review/signing-hash.js";
import { admitSigningCompletion, createSigningCompletion, signingDirectDecisionSchema, signingResponseContext, signingReviewSchema } from "../../src/review/signing-contracts.js";
import { createRequestReviewMaterialStore } from "../../src/runtime/request-review-material.js";
import { createExchangeFixture } from "./fixture.js";
import { observeExchange } from "../../src/review/preparation.js";
import { createReadyExchangeReview } from "../../src/review/contracts.js";
import { signingApplicationContracts } from "../../src/review/signing-application-contracts.js";

// Official fixed vector: https://eips.ethereum.org/assets/eip-712/Example.js
// chain 1 is codec evidence only; product admission is tested separately.
const mail: TypedSigningPayload = {
  kind: "typed_data", primaryType: "Mail", types: {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
    Person: [{ name: "name", type: "string" }, { name: "wallet", type: "address" }],
    Mail: [{ name: "from", type: "Person" }, { name: "to", type: "Person" }, { name: "contents", type: "string" }],
  },
  domain: { name: "Ether Mail", version: "1", chainId: "1", verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" },
  message: { from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" }, contents: "Hello, Bob!" },
};
const mailHash = parseHash32("0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2");
const mailSignature = "0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c";
const account = evmAccountIdentitySchema.parse({ chainId: "eip155:4663", address: "0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826" });
const codec = createSigningCodec();
const productMail = () => ({ ...structuredClone(mail), domain: { ...mail.domain, chainId: "4663" } });

describe("signing meaning and private result contract", () => {
  it("rejects unsafe record keys before a parser can silently remove them", () => {
    const data = { kind: "typed_data", types: { EIP712Domain: [], Test: [{ name: "constructor", type: "string" }] },
      primaryType: "Test", domain: {}, message: { constructor: "__proto__" } };
    expect(admitSigningPayload(data)).toEqual(data);
    for (const path of ["types", "domain", "message"] as const) {
      const malformed = JSON.parse(JSON.stringify(data)) as Record<string, Record<string, unknown>>;
      Object.defineProperty(malformed[path]!, "__proto__", { value: [], enumerable: true });
      expect(signingPayloadSchema.safeParse(malformed).success).toBe(false);
      expect(() => signingApplicationContracts.start.parseInput({ account: { kind: "active_wallet" }, payload: malformed })).toThrow();
    }
    const nested = JSON.parse('{"kind":"typed_data","types":{"EIP712Domain":[],"Test":[{"name":"child","type":"Empty"}],"Empty":[]},"primaryType":"Test","domain":{},"message":{"child":{"__proto__":"undeclared"}}}');
    expect(signingPayloadSchema.safeParse(nested).success).toBe(false);
  });
  it("matches the official Mail hash/signature and refuses each changed comparison operand", async () => {
    expect(codec.hashTypedData(signingTypedDataValues(mail))).toBe(mailHash);
    expect(await verifyDataSignature(codec, account, mailHash, mailSignature)).toBe("verified");
    const changed = structuredClone(mail); changed.message["contents"] = "Different message";
    expect(await verifyDataSignature(codec, account, codec.hashTypedData(signingTypedDataValues(changed)), mailSignature)).toBe("verification_failed");
    changed.message = mail.message; changed.domain["name"] = "Different domain";
    expect(await verifyDataSignature(codec, account, codec.hashTypedData(signingTypedDataValues(changed)), mailSignature)).toBe("verification_failed");
    expect(await verifyDataSignature(codec, { ...account, address: `0x${"11".repeat(20)}` as typeof account.address }, mailHash, mailSignature)).toBe("verification_failed");
    expect(await verifyDataSignature(codec, account, mailHash, `0x${"00".repeat(64)}1b`)).toBe("verification_failed");
    expect(await verifyDataSignature(codec, account, mailHash, mailSignature.slice(0, -2))).toBe("unsupported_signature");
    expect(signingPayloadSchema.safeParse(mail).success).toBe(false);
    expect(signingPayloadSchema.safeParse(productMail()).success).toBe(true);
  });

  it("signs exact UTF-8 bytes and explicit hex without guessing a text prefix", () => {
    // Independently specified ERC-191 preimage: 0x19, ASCII prefix, ASCII '2', c3 a9.
    const expected = keccak256FromHex("0x19457468657265756d205369676e6564204d6573736167653a0a32c3a9");
    expect(hashSigningPayload(codec, { kind: "personal", encoding: "utf8", value: "é" })).toBe(expected);
    expect(hashSigningPayload(codec, { kind: "personal", encoding: "hex", value: "0xC3A9" })).toBe(expected);
    expect(hashSigningPayload(codec, { kind: "personal", encoding: "utf8", value: "0x" })).not.toBe(
      hashSigningPayload(codec, { kind: "personal", encoding: "hex", value: "0x" }));
    expect(signingPayloadSchema.safeParse({ kind: "personal", encoding: "utf8", value: "\ud800" }).success).toBe(false);
  });

  it("admits exact declared fields, widths and array lengths, including recursive types with finite values", () => {
    const data = { kind: "typed_data", types: { EIP712Domain: [], Entry: [{ name: "values", type: "int8[2]" }, { name: "children", type: "Entry[]" }] },
      primaryType: "Entry", domain: {}, message: { values: ["-128", "127"], children: [] } } as const;
    expect(signingPayloadSchema.safeParse(data).success).toBe(true);
    for (const values of [["-129", "127"], ["-128", "128"], ["-128"], [-128, 127], ["-0", "127"]]) {
      expect(signingPayloadSchema.safeParse({ ...data, message: { ...data.message, values } }).success).toBe(false);
    }
    for (const message of [{ ...data.message, extra: "1" }, { children: [] }]) {
      expect(signingPayloadSchema.safeParse({ ...data, message }).success).toBe(false);
    }
    expect(signingPayloadSchema.safeParse({ ...data, primaryType: "EIP712Domain", message: {} }).success).toBe(false);
    const absent = admitSigningPayload(data);
    expect(absent).toMatchObject({ domain: {} });
  });

  it("binds private bytes with independent SHA-256 and never supplies a value on non-verified outcomes", () => {
    const context = { operationId: Buffer.alloc(32, 7).toString("base64url"), account, method: "eth_signTypedData_v4" as const, messageHash: mailHash };
    const completed = createSigningCompletion(context, "verified", mailSignature);
    const expectedDigest = createHash("sha256").update(Buffer.from(mailSignature.slice(2), "hex")).digest("hex");
    expect(completed.outcome).toMatchObject({ status: "verified", signatureDigest: expectedDigest });
    expect(JSON.stringify(completed.outcome)).not.toContain(mailSignature);
    expect(() => admitSigningCompletion(context, { outcome: completed.outcome })).toThrow();
    expect(() => admitSigningCompletion(context, { outcome: completed.outcome, signature: `${mailSignature.slice(0, -2)}1b` })).toThrow();
    for (const status of ["not_sent", "wallet_rejected", "delivery_unknown", "verification_failed", "unsupported_signature"] as const) {
      const result = createSigningCompletion(context, status);
      expect(result).not.toHaveProperty("signature");
      expect(() => admitSigningCompletion(context, { ...result, signature: mailSignature })).toThrow();
    }
  });

  it("counts both kinds and reservations in one capacity and consumes a signing Review once", async () => {
    const fixture = createExchangeFixture();
    const store = createRequestReviewMaterialStore(fixture.deps.clock);
    try {
      const exchange = await observeExchange(fixture.deps, fixture.input, new AbortController().signal);
      if (!exchange.ok) throw new Error("Complete exchange fixture required.");
      const first = store.reserve(fixture.input.operationId, fixture.input.createdAt, fixture.input.actionExpiresAt);
      store.publish(first, { kind: "transaction", review: createReadyExchangeReview(exchange.review), request: exchange.privateRequest, command: fixture.input.request });
      const payload = admitSigningPayload(productMail());
      const review = signingReviewSchema.parse({ contractVersion: "1", state: "ready_for_wallet_review", operationId: Buffer.alloc(32, 9).toString("base64url"),
        account, method: "eth_signTypedData_v4", messageHash: hashSigningPayload(codec, payload), createdAt: fixture.input.createdAt,
        actionExpiresAt: fixture.input.actionExpiresAt, sessionSourceId: "synthetic-session", connectionRevision: "1", payload });
      const slot = store.reserve(review.operationId, review.createdAt, review.actionExpiresAt);
      store.publish(slot, { kind: "signing", review, command: { account: { kind: "active_wallet" }, payload } });
      for (let i = 0; i < 14; i++) store.reserve(Buffer.alloc(32, i + 20).toString("base64url"), review.createdAt, review.actionExpiresAt);
      expect(() => store.reserve(Buffer.alloc(32, 99).toString("base64url"), review.createdAt, review.actionExpiresAt)).toThrow();
      expect(store.consume(review)).toEqual({ kind: "signing", payload, context: signingResponseContext(review) });
      expect(store.read(review.operationId)).toBeNull();
      expect(() => store.consume(review)).toThrow();
      expect(signingDirectDecisionSchema.safeParse({ review: { ...review, payload: { kind: "personal", encoding: "utf8", value: "a".repeat(32768) } }, initiatedBy: "mcp_app" }).success).toBe(false);
    } finally { store.close(); await fixture.close(); }
  });
});
