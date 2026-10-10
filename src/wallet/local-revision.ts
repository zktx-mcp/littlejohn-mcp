import { unsignedDecimalSchema, type UnsignedDecimal } from "../core/client.js";

// The product counters are stored as nonnegative SQLite signed 64-bit INTEGERs.
export const walletLocalRevisionMaximum = (1n << 63n) - 1n;
export const walletLocalRevisionDecimalBytes = walletLocalRevisionMaximum.toString().length;
export const walletLocalRevisionSchema = unsignedDecimalSchema
  .max(walletLocalRevisionDecimalBytes).refine((value) => value.length < walletLocalRevisionDecimalBytes ||
    (value.length === walletLocalRevisionDecimalBytes && value <= walletLocalRevisionMaximum.toString()),
    "Wallet local revision exceeds SQLite INTEGER representation.");
export const parseWalletLocalRevision = (value: unknown): UnsignedDecimal => walletLocalRevisionSchema.parse(value);
export const nextWalletLocalRevision = (value: string): UnsignedDecimal =>
  parseWalletLocalRevision((BigInt(parseWalletLocalRevision(value)) + 1n).toString());
