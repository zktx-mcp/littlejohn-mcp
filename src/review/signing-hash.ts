import type { SigningCodec } from "../chain/signing-port.js";
import { admitSigningPayload, personalSigningHex, signingTypedDataValues, type SigningPayload } from "./signing-payload.js";

export const hashSigningPayload = (codec: SigningCodec, input: SigningPayload) => {
  const payload = admitSigningPayload(input);
  return payload.kind === "personal" ? codec.hashMessage(personalSigningHex(payload)) : codec.hashTypedData(signingTypedDataValues(payload));
};
