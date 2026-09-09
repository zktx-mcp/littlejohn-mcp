import { chainInterfaceErrorMappings } from "../chain/error-mappings.js";
import { receiptActivityErrorRegistry, receiptActivityErrorDefinitions } from "./errors.js";
export const receiptActivityInterfaceErrorMappings = chainInterfaceErrorMappings.extend(receiptActivityErrorRegistry,
  receiptActivityErrorDefinitions.map((entry) => ({ code: entry.code, httpStatus: 409 as const, problemTitle: entry.message, cliExitCode: 2 as const })));
