import { createApplicationFailure, type ApplicationFailure } from "../../core/index.js";
import { cardErrorDefinitions, cardErrorRegistry } from "./card-contract.js";
import { exchangeInterfaceErrorMappings } from "../../review/error-mappings.js";
import { tokenCatalogInterfaceErrorMappingDefinitions } from "../../token-catalog/client.js";

export const cardInterfaceErrorMappings = exchangeInterfaceErrorMappings.extend(cardErrorRegistry, [...tokenCatalogInterfaceErrorMappingDefinitions, ...cardErrorDefinitions.map((value) => ({
  code: value.code, httpStatus: 409 as const, problemTitle: value.message, cliExitCode: 2 as const,
}))]);
export class CardError extends Error {
  readonly failure: ApplicationFailure;
  constructor(code: string) {
    const failure = createApplicationFailure(cardErrorRegistry, code);
    super(failure.error.message);
    this.name = "CardError";
    this.failure = failure;
  }
}
