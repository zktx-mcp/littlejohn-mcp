import {
  createApplicationFailure,
  type ApplicationFailure,
} from "../core/index.js";
import { walletErrorRegistry, walletInterfaceErrorMappings } from "../wallet/errors.js";

const chainDefinitions = [
  {
    code: "not_found",
    category: "domain",
    message: "The requested data was not found.",
    retryable: false,
  },
  {
    code: "unsupported_capability",
    category: "domain",
    message: "The requested capability is not supported.",
    retryable: false,
  },
  {
    code: "source_unavailable",
    category: "source",
    message: "A required data source is unavailable.",
    retryable: true,
  },
  {
    code: "source_inconsistent",
    category: "source",
    message: "Required source evidence is inconsistent.",
    retryable: false,
  },
  {
    code: "rate_limited",
    category: "source",
    message: "A required data source rate-limited the request.",
    retryable: true,
  },
] as const;

export type ChainErrorCode = typeof chainDefinitions[number]["code"];

export const chainErrorRegistry = walletErrorRegistry.extend(chainDefinitions);

export const chainInterfaceErrorMappings = walletInterfaceErrorMappings.extend(chainErrorRegistry, [
  { code: "not_found", httpStatus: 404, problemTitle: "Data not found", cliExitCode: 3 },
  {
    code: "unsupported_capability",
    httpStatus: 422,
    problemTitle: "Unsupported capability",
    cliExitCode: 3,
  },
  {
    code: "source_unavailable",
    httpStatus: 503,
    problemTitle: "Source unavailable",
    cliExitCode: 4,
  },
  {
    code: "source_inconsistent",
    httpStatus: 502,
    problemTitle: "Source inconsistent",
    cliExitCode: 4,
  },
  { code: "rate_limited", httpStatus: 429, problemTitle: "Rate limited", cliExitCode: 4 },
]);

export const createChainFailure = (code: string): ApplicationFailure =>
  createApplicationFailure(chainErrorRegistry, code);

const chainOperationFailures = new WeakMap<object, ApplicationFailure>();

export class ChainOperationError extends Error {
  readonly failure: ApplicationFailure;

  constructor(code: string) {
    const failure = createChainFailure(code);
    super(failure.error.message);
    this.name = "ChainOperationError";
    this.failure = failure;
    chainOperationFailures.set(this, failure);
    Object.freeze(this);
  }
}

export const getChainOperationFailure = (error: unknown): ApplicationFailure | undefined =>
  typeof error === "object" && error !== null
    ? chainOperationFailures.get(error)
    : undefined;
