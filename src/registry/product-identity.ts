import {deriveEip155Reference, parseEvmChainId} from "../evm/identities.js";

/** Runtime projection of the product identity owned by docs/PRODUCT_POLICY.md. */
export const productDisplayName = "Little John" as const;
export const productChainId = parseEvmChainId("eip155:4663");

const numericChainId = Number(deriveEip155Reference(productChainId));
if (!Number.isSafeInteger(numericChainId) || numericChainId <= 0) {
  throw new TypeError("The product chain ID has no safe positive numeric representation.");
}
export const productChainNumericId = numericChainId;
