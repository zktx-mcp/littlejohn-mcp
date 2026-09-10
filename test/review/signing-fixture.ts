import { vi } from "vitest";
import { createRequire } from "node:module";
import { createCanonicalClock, createObservationAuthority, sourceReferenceSchema, parseUnsignedDecimal, walletConnectionDataSchema } from "../../src/core/index.js";
import { createSigningCodec } from "../../src/chain/evm-standard.js";
import type { SigningCodec } from "../../src/chain/signing-port.js";
import { createRequestReviewMaterialStore } from "../../src/runtime/request-review-material.js";
import type { ActiveWalletReadPort } from "../../src/wallet/coordinator.js";
import type { WalletRequestInput, WalletRequestResponse } from "../../src/wallet/request-contract.js";
import { SigningCoordinator } from "../../src/review/signing-coordinator.js";
import { signingCommandSchema } from "../../src/review/signing-contracts.js";


// Public synthetic test key. No real Wallet, credential, nonce or RPC dependency.
const { privateKeyToAccount } = createRequire(import.meta.url)("viem/accounts") as {
  privateKeyToAccount(key: string): { address: string; signMessage(input: { message: string }): Promise<`0x${string}`> };
};
export const signer = privateKeyToAccount(`0x${"0".repeat(63)}1`);
export const message = "Little John synthetic signing lifecycle test";
export const command = signingCommandSchema.parse({ account: { kind: "active_wallet" }, payload: { kind: "personal", encoding: "utf8", value: message } });
export const createSigningFixture = (codec: SigningCodec = createSigningCodec()) => {
  const clock = createCanonicalClock(() => new Date().toISOString());
  const materials = createRequestReviewMaterialStore(clock);
  let connected = true;
  let method = true;
  let revision = parseUnsignedDecimal("1");
  let expiresAt = "2030-01-01T00:00:00.000Z";
  const sourceId = `wallet-session:${"A".repeat(43)}`;
  const source = { sourceId, candidateId: sourceId, topicDigest: "A".repeat(43),
    observationAuthority: createObservationAuthority({ clock, sourceClass: "wallet_session", owner: "Synthetic Wallet session",
      reference: sourceReferenceSchema.parse({ kind: "wallet_session", sourceId, topicDigest: "A".repeat(43) }) }) };
  const activeWallet: ActiveWalletReadPort = { capture: () => ({
    connectionRevision: revision,
    connection: walletConnectionDataSchema.parse(connected ? { status: "connected", chainId: "eip155:4663", address: signer.address.toLowerCase(),
      approvedMethods: method ? ["eth_sendTransaction", "personal_sign"] : ["eth_sendTransaction"],
      approvedEvents: ["accountsChanged", "chainChanged"], expiresAt } : { status: "disconnected", reason: "no_session" }),
    ...(connected ? { sessionSource: source } : {}),
  }) };
  let reply!: (response: WalletRequestResponse) => void;
  let signalSent!: () => void;
  const sent = new Promise<void>((resolve) => { signalSent = resolve; });
  const startRequest = vi.fn(async (_input: WalletRequestInput) => {
    const response = new Promise<WalletRequestResponse>((resolve) => { reply = resolve; });
    signalSent(); return { response };
  });
  const wallet = { hasPendingRequest: () => false, startRequest };
  const coordinator = new SigningCoordinator({ clock, activeWallet, codec, materials, wallet });
  return { coordinator, materials, clock, activeWallet, wallet, codec, startRequest, sent, reply: (response: WalletRequestResponse) => reply(response),
    changeSession: () => { revision = parseUnsignedDecimal("2"); },
    extendSession: () => { expiresAt = "2031-01-01T00:00:00.000Z"; revision = parseUnsignedDecimal("2"); },
    disconnect: () => { connected = false; }, removeMethod: () => { method = false; },
    close: async () => { await coordinator.close(); materials.close(); } };
};
