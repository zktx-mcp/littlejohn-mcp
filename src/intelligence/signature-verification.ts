import {evmAccountIdentitySchema, type EvmAccountIdentity} from "../evm/identities.js";
import {parseHash32, type Hash32} from "../core/index.js";
import type { SigningCodec } from "../chain/signing-port.js";
import { dataSignatureSchema } from "./signature-contract.js";

// ERC-191/EIP-712 recovery profile; no RPC or contract-account validity claim.
export const verifyDataSignature = async (
  codec: SigningCodec, accountInput: EvmAccountIdentity, hashInput: Hash32, response: string,
): Promise<"verified" | "verification_failed" | "unsupported_signature"> => {
  const account = evmAccountIdentitySchema.parse(accountInput);
  const hash = parseHash32(hashInput);
  if (!dataSignatureSchema.safeParse(response).success) return "unsupported_signature";
  try { return await codec.recoverAddress(hash, response) === account.address ? "verified" : "verification_failed"; }
  catch { return "verification_failed"; }
};
