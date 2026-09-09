import { officialAssetInterfaceErrorMappings } from "../registry/errors.js";
import { exchangeErrorDefinitions, exchangeErrorRegistry } from "./errors.js";

export const exchangeInterfaceErrorMappings = officialAssetInterfaceErrorMappings.extend(exchangeErrorRegistry,
  exchangeErrorDefinitions.map((entry) => ({
    code: entry.code, httpStatus: entry.category === "source" ? 502 as const : 409 as const,
    problemTitle: entry.message, cliExitCode: entry.category === "source" ? 4 as const : 2 as const,
  })));
