import {
  captureCanonicalJson,
  coreErrorDefinitions,
  type CanonicalJson,
} from "../core/browser.js";
import {
  runtimeErrorDefinitions,
  runtimeInterfaceErrorMappingDefinitions,
} from "../runtime/error-definitions.js";
import {
  walletErrorDefinitions,
  walletInterfaceErrorMappingDefinitions,
} from "../wallet/error-definitions.js";

const browserErrorDefinitions = Object.freeze([
  ...coreErrorDefinitions,
  ...runtimeErrorDefinitions,
  ...walletErrorDefinitions,
]);
const browserInterfaceErrorMappingDefinitions = Object.freeze([
  ...runtimeInterfaceErrorMappingDefinitions,
  ...walletInterfaceErrorMappingDefinitions,
]);

export type BrowserErrorCode = typeof browserErrorDefinitions[number]["code"];
type BrowserErrorDefinition = typeof browserErrorDefinitions[number];

export interface BrowserProblemDetails {
  readonly type: "about:blank";
  readonly title: string;
  readonly status: number;
  readonly code: BrowserErrorCode;
  readonly detail: string;
  readonly retryable: boolean;
  readonly issues: readonly {
    readonly path: string;
    readonly code: string;
    readonly message: string;
  }[];
}

const definitionByCode: ReadonlyMap<string, BrowserErrorDefinition> = new Map<string, BrowserErrorDefinition>(
  browserErrorDefinitions.map((definition) => [definition.code, definition] as const),
);
const mappingByCode: ReadonlyMap<string, typeof browserInterfaceErrorMappingDefinitions[number]> = new Map(
  browserInterfaceErrorMappingDefinitions.map((mapping) => [mapping.code, mapping] as const),
);

if (
  definitionByCode.size !== browserErrorDefinitions.length ||
  mappingByCode.size !== browserInterfaceErrorMappingDefinitions.length ||
  [...definitionByCode.keys()].some((code) => !mappingByCode.has(code)) ||
  [...mappingByCode.keys()].some((code) => !definitionByCode.has(code))
) throw new TypeError("Browser error authority is incomplete.");

const canonicalObject = (
  value: CanonicalJson,
): value is { readonly [key: string]: CanonicalJson } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: { readonly [key: string]: CanonicalJson },
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

export const parseBrowserProblemDetails = (
  value: unknown,
  responseStatus: number,
): BrowserProblemDetails => {
  const captured = captureCanonicalJson(value);
  if (!canonicalObject(captured) || !hasExactKeys(captured, [
    "code",
    "detail",
    "issues",
    "retryable",
    "status",
    "title",
    "type",
  ])) throw new TypeError("The browser error response is invalid.");

  const { type, title, status, code, detail, retryable, issues } = captured;
  const definition = typeof code === "string" ? definitionByCode.get(code) : undefined;
  const mapping = typeof code === "string" ? mappingByCode.get(code) : undefined;
  if (
    type !== "about:blank" ||
    definition === undefined || mapping === undefined ||
    title !== mapping.problemTitle ||
    status !== mapping.httpStatus || status !== responseStatus ||
    detail !== definition.message ||
    retryable !== definition.retryable ||
    !Array.isArray(issues) || issues.length !== 0
  ) throw new TypeError("The browser error response is invalid.");

  return Object.freeze({
    type,
    title,
    status,
    code: definition.code,
    detail: definition.message,
    retryable: definition.retryable,
    issues: Object.freeze([]),
  });
};
