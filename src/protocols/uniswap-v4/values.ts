import { z } from "zod";
import {canonicalUnsignedBigIntMaximumPattern} from "../../evm/amounts.js";
import {jsonObject} from "../../core/client.js";

const unsignedWord = (bits: number) => z.string().regex(new RegExp(
  canonicalUnsignedBigIntMaximumPattern((1n << BigInt(bits)) - 1n), "u",
));

export const uniswapV4SwapAmountSchema = unsignedWord(128);
export const uniswapV4QuotedAmountSchema = unsignedWord(127);
export const uniswapV4PermitAllowanceSchema = jsonObject({
  amount: unsignedWord(160), expiration: unsignedWord(48), nonce: unsignedWord(48),
}).strict();
export const uniswapV4Slot0Schema = jsonObject({
  sqrtPriceX96: unsignedWord(160),
  tick: z.number().int().min(-(2 ** 23)).max(2 ** 23 - 1),
  protocolFee: z.number().int().nonnegative().max(2 ** 24 - 1),
  lpFee: z.number().int().nonnegative().max(2 ** 24 - 1),
}).strict();
