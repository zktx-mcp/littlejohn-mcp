import { canonicalJsonStringify, captureCanonicalJson } from "../core/client.js";
import { signingReviewSchema, type SigningOutcome } from "../review/signing-contracts.js";
import { personalSigningHex } from "../review/signing-payload.js";

// JSON escapes controls; separators and directional controls remain explicit in
// both interfaces rather than controlling terminal or visual text direction.
export const signingDataText = (value: unknown): string => canonicalJsonStringify(captureCanonicalJson(value))
  .replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
export const signingReviewFields = (input: unknown): readonly (readonly [string, string])[] => {
  const review = signingReviewSchema.parse(input);
  return [["Account", review.account.address], ["Wallet chain", review.account.chainId],
    ["Method", review.method], ["Decision deadline", review.actionExpiresAt], ["Decision ID", review.operationId],
    ["Chain binding", review.payload.kind === "personal" || !Object.hasOwn(review.payload.domain, "chainId")
      ? "The signed data is not chain-bound." : "The declared signing domain binds the Wallet chain."],
    ["Scope", "This command does not broadcast a transaction or establish external effects. Closing or expiry does not revoke a signature."],
    ["Exact signing data", signingDataText(review.payload)],
    ...(review.payload.kind === "personal" ? [["Exact message bytes", personalSigningHex(review.payload)] as const] : []),
  ];
};
export const signingReviewText = (input: unknown): string => ["Sign data", ...signingReviewFields(input).map(([label, value]) => `${label}: ${value}`)].join("\n");
const outcomes: Readonly<Record<SigningOutcome["status"], string>> = Object.freeze({
  verified: "The signature matches the reviewed data and selected account. It does not establish external effects.",
  verification_failed: "The returned signature did not verify against the reviewed data and selected account. No usable signature is delivered.",
  unsupported_signature: "The Wallet returned an unsupported signature format. Its validity was not established; no usable signature is delivered.",
  wallet_rejected: "The Wallet rejected the signature request.",
  not_sent: "The signature request was not sent.",
  delivery_unknown: "Waiting ended without an established result. The Wallet may still sign; no remote cancellation or absence of signing is established. This request will not be repeated.",
});
export const signingOutcomeText = (outcome: SigningOutcome): string => outcomes[outcome.status];
