import { z } from "zod";

export const sha256Algorithm = "sha256" as const;
export const sha256HexPatternSource = "[0-9a-f]{64}";
export const createSha256HexSchema = () => z.string().regex(new RegExp("^" + sha256HexPatternSource + "$"));
