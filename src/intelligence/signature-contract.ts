import { z } from "zod";

// r (32 bytes), s (32 bytes), and one recovery byte in the installed profile.
export const dataSignatureByteLength = 32 + 32 + 1;
export const dataSignatureSchema = z.string().regex(new RegExp(
  `^0x[0-9a-f]{${(dataSignatureByteLength - 1) * 2}}(?:00|01|1b|1c)$`, "u",
));
export const dataSignatureBytes = (value: string): Uint8Array => {
  const signature = dataSignatureSchema.parse(value);
  return Uint8Array.from(signature.slice(2).match(/../gu)!, (pair) => Number.parseInt(pair, 16));
};
