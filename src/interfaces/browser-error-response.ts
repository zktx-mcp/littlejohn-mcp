import {
  captureCanonicalJson,
  coreErrorDefinitions,
  fieldIssueSchema,
  type CanonicalJson,
  type FieldIssue,
} from "../core/browser.js";
import {
  chainErrorDefinitions,
  chainInterfaceErrorMappingDefinitions,
} from "../chain/error-definitions.js";
import {
  runtimeErrorDefinitions,
  runtimeInterfaceErrorMappingDefinitions,
} from "../runtime/error-definitions.js";
import {
  tokenCatalogErrorDefinitions,
  tokenCatalogInterfaceErrorMappingDefinitions,
} from "../token-catalog/browser.js";
import {
  walletErrorDefinitions,
  walletInterfaceErrorMappingDefinitions,
} from "../wallet/error-definitions.js";

const browserErrorDefinitions = Object.freeze([
  ...coreErrorDefinitions,
  ...runtimeErrorDefinitions,
  ...walletErrorDefinitions,
  ...chainErrorDefinitions,
  ...tokenCatalogErrorDefinitions,
]);
const browserInterfaceErrorMappingDefinitions = Object.freeze([
  ...runtimeInterfaceErrorMappingDefinitions,
  ...walletInterfaceErrorMappingDefinitions,
  ...chainInterfaceErrorMappingDefinitions,
  ...tokenCatalogInterfaceErrorMappingDefinitions,
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
  readonly issues: readonly FieldIssue[];
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
  const parsedIssues = Array.isArray(issues)
    ? fieldIssueSchema.array().max(64).safeParse(issues)
    : undefined;
  if (
    type !== "about:blank" ||
    definition === undefined || mapping === undefined ||
    title !== mapping.problemTitle ||
    status !== mapping.httpStatus || status !== responseStatus ||
    detail !== definition.message ||
    retryable !== definition.retryable ||
    parsedIssues === undefined || !parsedIssues.success
  ) throw new TypeError("The browser error response is invalid.");

  const canonicalIssues = Object.freeze(parsedIssues.data.map((issue) => Object.freeze(issue)));

  return Object.freeze({
    type,
    title,
    status,
    code: definition.code,
    detail: definition.message,
    retryable: definition.retryable,
    issues: canonicalIssues,
  });
};
