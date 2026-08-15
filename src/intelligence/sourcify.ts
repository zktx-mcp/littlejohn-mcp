import {
  captureCanonicalJson,
  compareCodePointSequences,
  contractControlInterfaceDefinitions,
  contractDeclaredFunctionCountLimit,
  contractDeclaredFunctionUtf16CodeUnitLimit,
  createObservationAuthorityIssuer,
  deriveEip155Reference,
  exactContractInterfaceSchema,
  evmAddressSchema,
  hexBytesSchema,
  isWellFormedText,
  parseSourceReference,
  type CanonicalClock,
  type CanonicalJson,
  type ContractControlEventDefinition,
  type ContractControlFunctionDefinition,
  type EvmAddress,
  type ExactContractInterface,
  type ObservationAuthorityRegistration,
  type SourceReference,
} from "../core/index.js";
import type {
  ContractSourceVerification,
  ContractSourceVerificationPort,
  ContractSourceVerificationRequest,
} from "./ports.js";
import { createContractSourceVerificationPort } from "./ports.js";
import * as sourcifyAbiFormatNamespace from "./sourcify-abi-format.cjs";

type SourcifyAbiFormatModule = Readonly<{
  formatAbiItem(
    item: Readonly<Record<string, unknown>>,
    options?: Readonly<{ includeName?: boolean }>,
  ): string;
  formatAbiParams(
    parameters: readonly Readonly<Record<string, unknown>>[],
    options: Readonly<{ includeName: boolean }>,
  ): string;
  parseAbiItem(signature: string): Readonly<Record<string, unknown>>;
  parseAbiParameter(signature: string): Readonly<Record<string, unknown>>;
}>;

const sourcifyAbiFormat = (
  sourcifyAbiFormatNamespace as unknown as Readonly<{ readonly default: unknown }>
).default as SourcifyAbiFormatModule;

const sourcifyOrigin = "https://sourcify.dev";
const sourcifyPathPrefix = "/server/v2/contract";
const sourcifyFields = "abi,runtimeBytecode.onchainBytecode";
const sourcifySourceId = "sourcify-v2";
const sourcifyMaximumResponseBytes = 1_048_576;
const sourcifyRequestDeadlineMilliseconds = 10_000;
const sourcifyMaximumActiveRequests = 4;

type JsonObject = Readonly<Record<string, CanonicalJson>>;

const isJsonObject = (value: CanonicalJson | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: CanonicalJson | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const jsonTextIsWellFormed = (input: unknown): boolean => {
  const pending: unknown[] = [input];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (!isWellFormedText(value)) return false;
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) pending.push(entry);
      continue;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!isWellFormedText(key)) return false;
      pending.push(entry);
    }
  }
  return true;
};

const abiKinds = [
  "function",
  "event",
  "error",
  "constructor",
  "fallback",
  "receive",
] as const;

type AbiKind = typeof abiKinds[number];
const functionStateMutabilities = Object.freeze([
  "pure",
  "view",
  "nonpayable",
  "payable",
] as const);
const payableStateMutabilities = Object.freeze(["nonpayable", "payable"] as const);
type FunctionStateMutability = typeof functionStateMutabilities[number];
type PayableStateMutability = typeof payableStateMutabilities[number];

const abiSemanticFields = Object.freeze([
  "type",
  "name",
  "inputs",
  "outputs",
  "stateMutability",
  "constant",
  "payable",
  "gas",
  "anonymous",
  "internalType",
  "components",
  "indexed",
] as const);

type AbiSemanticField = typeof abiSemanticFields[number];

const abiSemanticFieldsByKind = {
  function: [
    "type",
    "name",
    "inputs",
    "outputs",
    "stateMutability",
    "constant",
    "payable",
    "gas",
  ],
  event: ["type", "name", "inputs", "anonymous"],
  error: ["type", "name", "inputs"],
  constructor: ["type", "inputs", "stateMutability", "payable"],
  fallback: ["type", "stateMutability", "payable"],
  receive: ["type", "stateMutability"],
} as const satisfies Record<AbiKind, readonly AbiSemanticField[]>;

const abiParameterSemanticFields = [
  "type",
  "name",
  "internalType",
  "components",
  "indexed",
] as const satisfies readonly AbiSemanticField[];

type CanonicalAbiParameter = Readonly<{
  readonly type: string;
  readonly name?: string;
  readonly internalType?: string;
  readonly components?: readonly CanonicalAbiParameter[];
}>;
type CanonicalAbiEventParameter = CanonicalAbiParameter & Readonly<{
  readonly indexed: boolean;
}>;
type CanonicalAbiItem =
  | Readonly<{
      readonly type: "function";
      readonly name: string;
      readonly inputs: readonly CanonicalAbiParameter[];
      readonly outputs: readonly CanonicalAbiParameter[];
      readonly stateMutability: FunctionStateMutability;
      readonly signature: string;
    }>
  | Readonly<{
      readonly type: "event";
      readonly name: string;
      readonly inputs: readonly CanonicalAbiEventParameter[];
      readonly anonymous: boolean;
    }>
  | Readonly<{
      readonly type: "error";
      readonly name: string;
      readonly inputs: readonly CanonicalAbiParameter[];
    }>
  | Readonly<{
      readonly type: "constructor";
      readonly inputs: readonly CanonicalAbiParameter[];
      readonly stateMutability: PayableStateMutability;
    }>
  | Readonly<{ readonly type: "fallback"; readonly stateMutability: PayableStateMutability }>
  | Readonly<{ readonly type: "receive"; readonly stateMutability: "payable" }>;

type AbiEntryAdmission =
  | Readonly<{ readonly status: "admitted"; readonly item: CanonicalAbiItem }>
  | Readonly<{ readonly status: "inconsistent" }>
  | Readonly<{ readonly status: "unavailable" }>;

type OptionalBoolean =
  | Readonly<{ readonly status: "absent" }>
  | Readonly<{ readonly status: "invalid" }>
  | Readonly<{ readonly status: "present"; readonly value: boolean }>;

const inconsistentAbiEntry = Object.freeze({ status: "inconsistent" as const });
const unavailableAbiEntry = Object.freeze({ status: "unavailable" as const });

const readOptionalBoolean = (entry: JsonObject, field: string): OptionalBoolean => {
  if (!Object.hasOwn(entry, field)) return Object.freeze({ status: "absent" });
  const value = entry[field];
  return typeof value === "boolean"
    ? Object.freeze({ status: "present", value })
    : Object.freeze({ status: "invalid" });
};

const isAbiKind = (value: string | undefined): value is AbiKind =>
  abiKinds.some((kind) => kind === value);

const isFunctionStateMutability = (
  value: string | undefined,
): value is FunctionStateMutability =>
  functionStateMutabilities.some((stateMutability) => stateMutability === value);

const isPayableStateMutability = (
  value: string | undefined,
): value is PayableStateMutability =>
  payableStateMutabilities.some((stateMutability) => stateMutability === value);

const hasOnlyOwnedSemanticFields = (
  entry: JsonObject,
  owned: readonly AbiSemanticField[],
): boolean => {
  return abiSemanticFields.every((field) =>
    !Object.hasOwn(entry, field) || owned.some((candidate) => candidate === field));
};

function canonicalParameter(
  value: CanonicalJson,
  eventInput: true,
): CanonicalAbiEventParameter | null;
function canonicalParameter(
  value: CanonicalJson,
  eventInput: false,
): CanonicalAbiParameter | null;
function canonicalParameter(
  value: CanonicalJson,
  eventInput: boolean,
): CanonicalAbiParameter | CanonicalAbiEventParameter | null {
  if (!isJsonObject(value)) return null;
  if (!hasOnlyOwnedSemanticFields(value, abiParameterSemanticFields)) return null;
  const type = readString(value["type"]);
  if (type === undefined) return null;
  const name = value["name"];
  if (name !== undefined && typeof name !== "string") return null;
  const internalType = value["internalType"];
  if (internalType !== undefined && typeof internalType !== "string") return null;
  const indexed = readOptionalBoolean(value, "indexed");
  if (indexed.status === "invalid" || (!eventInput && indexed.status !== "absent")) return null;
  const componentsInput = value["components"];
  const tuple = type.startsWith("tuple");
  if (tuple !== Array.isArray(componentsInput)) return null;
  let components: readonly CanonicalAbiParameter[] | undefined;
  if (Array.isArray(componentsInput)) {
    const admitted: CanonicalAbiParameter[] = [];
    for (const component of componentsInput) {
      const normalized = canonicalParameter(component, false);
      if (normalized === null) return null;
      admitted.push(normalized);
    }
    components = Object.freeze(admitted);
  }
  return Object.freeze({
    type,
    ...(name === undefined ? {} : { name }),
    ...(internalType === undefined ? {} : { internalType }),
    ...(components === undefined ? {} : { components }),
    ...(eventInput
      ? { indexed: indexed.status === "present" ? indexed.value : false }
      : {}),
  });
}

function canonicalParameters(
  value: CanonicalJson | undefined,
  eventInputs: true,
): readonly CanonicalAbiEventParameter[] | null;
function canonicalParameters(
  value: CanonicalJson | undefined,
  eventInputs: false,
): readonly CanonicalAbiParameter[] | null;
function canonicalParameters(
  value: CanonicalJson | undefined,
  eventInputs: boolean,
): readonly (CanonicalAbiParameter | CanonicalAbiEventParameter)[] | null {
  if (!Array.isArray(value)) return null;
  const admitted: Array<CanonicalAbiParameter | CanonicalAbiEventParameter> = [];
  for (const parameter of value) {
    const normalized = eventInputs
      ? canonicalParameter(parameter, true)
      : canonicalParameter(parameter, false);
    if (normalized === null) return null;
    admitted.push(normalized);
  }
  try {
    for (const parameter of admitted) {
      const signature = sourcifyAbiFormat.formatAbiParams([parameter], {
        includeName: true,
      });
      sourcifyAbiFormat.parseAbiParameter(signature);
    }
  } catch {
    return null;
  }
  return Object.freeze(admitted);
}

const functionStateMutability = (entry: JsonObject): FunctionStateMutability | null => {
  const explicitInput = readString(entry["stateMutability"]);
  if (Object.hasOwn(entry, "stateMutability") &&
    !isFunctionStateMutability(explicitInput)) return null;
  const explicit = isFunctionStateMutability(explicitInput) ? explicitInput : undefined;
  const constant = readOptionalBoolean(entry, "constant");
  const payable = readOptionalBoolean(entry, "payable");
  if (constant.status === "invalid" || payable.status === "invalid") return null;
  const gas = entry["gas"];
  if (
    Object.hasOwn(entry, "gas") &&
    (typeof gas !== "number" || !Number.isSafeInteger(gas) || gas < 0)
  ) return null;
  if (explicit === undefined) {
    if (constant.status !== "present" || payable.status !== "present") return null;
    if (constant.value && payable.value) return null;
    if (constant.value) return "view";
    return payable.value ? "payable" : "nonpayable";
  }
  const expectedConstant = explicit === "pure" || explicit === "view";
  const expectedPayable = explicit === "payable";
  if (
    (constant.status === "present" && constant.value !== expectedConstant) ||
    (payable.status === "present" && payable.value !== expectedPayable)
  ) return null;
  return explicit;
};

const payableStateMutability = (entry: JsonObject): PayableStateMutability | null => {
  const explicitInput = readString(entry["stateMutability"]);
  if (Object.hasOwn(entry, "stateMutability") &&
    !isPayableStateMutability(explicitInput)) return null;
  const explicit = isPayableStateMutability(explicitInput) ? explicitInput : undefined;
  const payable = readOptionalBoolean(entry, "payable");
  if (payable.status === "invalid") return null;
  if (explicit === undefined) {
    return payable.status === "present"
      ? payable.value ? "payable" : "nonpayable"
      : null;
  }
  if (payable.status === "present" && payable.value !== (explicit === "payable")) return null;
  return explicit;
};

const parsedNamedAbiItem = (
  entry: Readonly<Record<string, unknown>>,
  type: "function" | "event" | "error",
): Readonly<Record<string, unknown>> | null => {
  try {
    const signature = sourcifyAbiFormat.formatAbiItem(entry, { includeName: true });
    const parsed = sourcifyAbiFormat.parseAbiItem(`${type} ${signature}`);
    return parsed["type"] === type ? parsed : null;
  } catch {
    return null;
  }
};

const admitAbiEntry = (entry: JsonObject): AbiEntryAdmission => {
  const type = readString(entry["type"]);
  if (!isAbiKind(type) || !hasOnlyOwnedSemanticFields(entry, abiSemanticFieldsByKind[type])) {
    return inconsistentAbiEntry;
  }
  switch (type) {
    case "function": {
      const name = readString(entry["name"]);
      const inputs = canonicalParameters(entry["inputs"], false);
      const outputs = canonicalParameters(entry["outputs"], false);
      const stateMutability = functionStateMutability(entry);
      if (name === undefined || inputs === null || outputs === null || stateMutability === null) {
        return inconsistentAbiEntry;
      }
      const item = Object.freeze({ type, name, inputs, outputs, stateMutability });
      let signature: string;
      try {
        signature = sourcifyAbiFormat.formatAbiItem(item);
      } catch {
        return inconsistentAbiEntry;
      }
      if (
        signature.length === 0 ||
        !signature.includes("(") ||
        !signature.endsWith(")")
      ) return inconsistentAbiEntry;
      if (signature.length > contractDeclaredFunctionUtf16CodeUnitLimit) {
        return unavailableAbiEntry;
      }
      if (parsedNamedAbiItem(item, "function") === null) return inconsistentAbiEntry;
      return Object.freeze({
        status: "admitted",
        item: Object.freeze({ ...item, signature }),
      });
    }
    case "event": {
      const name = readString(entry["name"]);
      const inputs = canonicalParameters(entry["inputs"], true);
      const anonymous = readOptionalBoolean(entry, "anonymous");
      if (name === undefined || inputs === null || anonymous.status === "invalid") {
        return inconsistentAbiEntry;
      }
      const item = Object.freeze({
        type,
        name,
        inputs,
        anonymous: anonymous.status === "present" ? anonymous.value : false,
      });
      return parsedNamedAbiItem(item, "event") === null
        ? inconsistentAbiEntry
        : Object.freeze({ status: "admitted", item });
    }
    case "error": {
      const name = readString(entry["name"]);
      const inputs = canonicalParameters(entry["inputs"], false);
      if (name === undefined || inputs === null) return inconsistentAbiEntry;
      const item = Object.freeze({
        type,
        name,
        inputs,
      });
      return parsedNamedAbiItem(item, "error") === null
        ? inconsistentAbiEntry
        : Object.freeze({ status: "admitted", item });
    }
    case "constructor": {
      const inputs = canonicalParameters(entry["inputs"], false);
      const stateMutability = payableStateMutability(entry);
      if (inputs === null || stateMutability === null) return inconsistentAbiEntry;
      return Object.freeze({
        status: "admitted",
        item: Object.freeze({
          type,
          inputs,
          stateMutability,
        }),
      });
    }
    case "fallback": {
      const stateMutability = payableStateMutability(entry);
      return stateMutability === null
        ? inconsistentAbiEntry
        : Object.freeze({
            status: "admitted",
            item: Object.freeze({ type, stateMutability }),
          });
    }
    case "receive":
      return entry["stateMutability"] === "payable"
        ? Object.freeze({
            status: "admitted",
            item: Object.freeze({ type, stateMutability: "payable" }),
          })
        : inconsistentAbiEntry;
  }
};

const requestReference = (
  request: ContractSourceVerificationRequest,
): Extract<SourceReference, { readonly kind: "public" }> => {
  const chainReference = deriveEip155Reference(request.chainId);
  const url = new URL(
    `${sourcifyPathPrefix}/${chainReference}/${request.address}`,
    sourcifyOrigin,
  );
  url.searchParams.set("fields", sourcifyFields);
  if (
    url.origin !== sourcifyOrigin ||
    url.pathname !== `${sourcifyPathPrefix}/${chainReference}/${request.address}` ||
    url.searchParams.size !== 1 ||
    url.searchParams.get("fields") !== sourcifyFields
  ) {
    throw new TypeError("Sourcify request identity is invalid.");
  }
  const reference = parseSourceReference({
    kind: "public",
    sourceId: sourcifySourceId,
    uri: url.href,
  });
  if (reference.kind !== "public") throw new TypeError("Sourcify reference is invalid.");
  return Object.freeze(reference);
};

const cancelResponseBody = (response: Response): void => {
  if (response.body === null) return;
  void response.body.cancel().catch(() => undefined);
};

const readResponseBody = async (
  response: Response,
  signal: AbortSignal,
): Promise<
  | Readonly<{ readonly status: "admitted"; readonly value: CanonicalJson }>
  | Readonly<{ readonly status: "inconsistent" }>
  | Readonly<{ readonly status: "unavailable" }>
> => {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    cancelResponseBody(response);
    return Object.freeze({ status: "inconsistent" });
  }
  if (response.body === null) return Object.freeze({ status: "inconsistent" });
  if (signal.aborted) {
    cancelResponseBody(response);
    throw signal.reason;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let completed = false;
  let failure: unknown;
  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectForAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      rejectForAbort();
      return;
    }
    signal.addEventListener("abort", rejectForAbort, { once: true });
    removeAbortListener = (): void => signal.removeEventListener("abort", rejectForAbort);
  });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) {
        completed = true;
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > sourcifyMaximumResponseBytes) {
        throw new RangeError("Sourcify response exceeds the adapter limit.");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (!completed) {
      void reader.cancel(failure).catch(() => undefined);
    }
    reader.releaseLock();
    removeAbortListener();
  }
  if (!completed) {
    if (signal.aborted) throw signal.reason;
    return Object.freeze({ status: "unavailable" });
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    if (!jsonTextIsWellFormed(parsed)) return Object.freeze({ status: "inconsistent" });
    try {
      return Object.freeze({
        status: "admitted",
        value: captureCanonicalJson(parsed),
      });
    } catch {
      return Object.freeze({ status: "unavailable" });
    }
  } catch {
    return Object.freeze({ status: "inconsistent" });
  }
};

const sameParameters = (
  inputs: readonly CanonicalAbiParameter[],
  expected: readonly Readonly<{ readonly type: string; readonly indexed?: boolean }>[],
): boolean => {
  if (inputs.length !== expected.length) return false;
  return inputs.every((input, index) => {
    const expectedInput = expected[index];
    return expectedInput !== undefined && input.type === expectedInput.type;
  });
};

const sameEventParameters = (
  inputs: readonly CanonicalAbiEventParameter[],
  expected: readonly Readonly<{ readonly type: string; readonly indexed?: boolean }>[],
): boolean => {
  if (inputs.length !== expected.length) return false;
  return inputs.every((input, index) => {
    const expectedInput = expected[index];
    return expectedInput !== undefined &&
      input.type === expectedInput.type &&
      input.indexed === (expectedInput.indexed ?? false);
  });
};

const matchesFunction = (
  entries: readonly CanonicalAbiItem[],
  expected: ContractControlFunctionDefinition,
): boolean => entries.some((entry) =>
  entry.type === "function" &&
  entry.name === expected.name &&
  sameParameters(entry.inputs, expected.inputs) &&
  sameParameters(entry.outputs, expected.outputs) &&
  expected.stateMutability.some((stateMutability) => stateMutability === entry.stateMutability));

const matchesEvent = (
  entries: readonly CanonicalAbiItem[],
  expected: ContractControlEventDefinition,
): boolean => entries.some((entry) =>
  entry.type === "event" &&
  entry.name === expected.name &&
  !entry.anonymous &&
  sameEventParameters(entry.inputs, expected.inputs));

type ExactInterfaceAdmission =
  | Readonly<{ readonly status: "admitted"; readonly value: ExactContractInterface }>
  | Readonly<{ readonly status: "inconsistent" }>
  | Readonly<{ readonly status: "unavailable" }>;

const exactContractInterface = (
  abiInput: CanonicalJson | undefined,
): ExactInterfaceAdmission => {
  if (!Array.isArray(abiInput)) return Object.freeze({ status: "inconsistent" });
  const entries: CanonicalAbiItem[] = [];
  const signatures: string[] = [];
  for (const entry of abiInput) {
    if (!isJsonObject(entry)) return Object.freeze({ status: "inconsistent" });
    const admission = admitAbiEntry(entry);
    if (admission.status !== "admitted") return admission;
    entries.push(admission.item);
    if (admission.item.type === "function") {
      signatures.push(admission.item.signature);
    }
  }
  if (signatures.length > contractDeclaredFunctionCountLimit) {
    return Object.freeze({ status: "unavailable" });
  }
  signatures.sort(compareCodePointSequences);
  if (new Set(signatures).size !== signatures.length) {
    return Object.freeze({ status: "inconsistent" });
  }

  const owner = contractControlInterfaceDefinitions.owner.functions.every((definition) =>
    matchesFunction(entries, definition)) &&
    contractControlInterfaceDefinitions.owner.events.every((definition) =>
      matchesEvent(entries, definition))
    ? "erc173"
    : "not_declared";
  const paused = contractControlInterfaceDefinitions.paused.functions.every((definition) =>
    matchesFunction(entries, definition))
    ? "declared"
    : "not_declared";
  const hasDefaultAdminBase =
    contractControlInterfaceDefinitions.defaultAdmins.baseFunctions.every((definition) =>
      matchesFunction(entries, definition));
  const hasDefaultAdminEnumeration =
    contractControlInterfaceDefinitions.defaultAdmins.enumerableFunctions.every((definition) =>
      matchesFunction(entries, definition));

  const admitted = exactContractInterfaceSchema.safeParse({
    declaredFunctions: Object.freeze(signatures),
    owner,
    paused,
    defaultAdmins: !hasDefaultAdminBase
      ? "not_declared"
      : hasDefaultAdminEnumeration
        ? "enumerable"
        : "not_enumerable",
  });
  return admitted.success
    ? Object.freeze({ status: "admitted", value: Object.freeze(admitted.data) })
    : Object.freeze({ status: "unavailable" });
};

const responseIdentityMatches = (
  value: JsonObject,
  request: ContractSourceVerificationRequest,
): boolean => {
  const chainId = readString(value["chainId"]);
  const address = readString(value["address"]);
  if (chainId !== deriveEip155Reference(request.chainId) || address === undefined) return false;
  const parsedAddress = evmAddressSchema.safeParse(address.toLowerCase());
  return parsedAddress.success && parsedAddress.data === request.address;
};

const classifyResponse = (
  response: Response,
  value: CanonicalJson,
  request: ContractSourceVerificationRequest,
  reference: Extract<SourceReference, { readonly kind: "public" }>,
  observationAuthority: ContractSourceVerification["observationAuthority"],
): ContractSourceVerification => {
  if (!isJsonObject(value)) {
    return Object.freeze({ status: "inconsistent", reference, observationAuthority });
  }
  if (response.status === 404) {
    const keys = Object.keys(value).sort(compareCodePointSequences);
    const expectedKeys = ["address", "chainId", "creationMatch", "match", "runtimeMatch"]
      .sort(compareCodePointSequences);
    const requestMatched =
      keys.length === expectedKeys.length &&
      keys.every((key, index) => key === expectedKeys[index]) &&
      value["match"] === null &&
      value["creationMatch"] === null &&
      value["runtimeMatch"] === null &&
      responseIdentityMatches(value, request);
    return Object.freeze({
      status: requestMatched ? "no_record_observed" : "inconsistent",
      reference,
      observationAuthority,
    });
  }
  if (response.status !== 200) {
    return Object.freeze({ status: "unavailable", reference, observationAuthority });
  }
  if (!responseIdentityMatches(value, request)) {
    return Object.freeze({ status: "inconsistent", reference, observationAuthority });
  }

  const runtimeMatch = value["runtimeMatch"];
  if (runtimeMatch === "match") {
    return Object.freeze({ status: "non_exact_match", reference, observationAuthority });
  }
  if (runtimeMatch !== "exact_match") {
    return Object.freeze({ status: "inconsistent", reference, observationAuthority });
  }
  const runtimeBytecode = value["runtimeBytecode"];
  if (!isJsonObject(runtimeBytecode)) {
    return Object.freeze({ status: "inconsistent", reference, observationAuthority });
  }
  const onchainBytecode = hexBytesSchema.safeParse(runtimeBytecode["onchainBytecode"]);
  if (!onchainBytecode.success) {
    return Object.freeze({ status: "inconsistent", reference, observationAuthority });
  }
  if (onchainBytecode.data !== request.runtimeBytecode) {
    return Object.freeze({ status: "inconsistent", reference, observationAuthority });
  }
  const exactInterface = exactContractInterface(value["abi"]);
  if (exactInterface.status !== "admitted") {
    return Object.freeze({
      status: exactInterface.status,
      reference,
      observationAuthority,
    });
  }
  return Object.freeze({
    status: "exact_match",
    reference,
    observationAuthority,
    exactInterface: exactInterface.value,
  });
};

const abortError = (): Error => {
  const error = new Error("request_aborted");
  error.name = "AbortError";
  return error;
};

export const createSourcifyContractSourceVerification = (input: {
  readonly clock: CanonicalClock;
  readonly fetch?: typeof fetch;
}): Readonly<{
  readonly port: ContractSourceVerificationPort;
  readonly observationAuthorityRegistration: ObservationAuthorityRegistration;
}> => {
  const fetchImplementation = input.fetch === undefined ? fetch : input.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("Sourcify fetch implementation is unavailable.");
  }
  const issuer = createObservationAuthorityIssuer({
    clock: input.clock,
    sourceClass: "contract_verification_service",
    owner: "Sourcify",
    referenceKind: "public",
    sourceId: sourcifySourceId,
  });
  let activeRequests = 0;

  const port = createContractSourceVerificationPort({
    observationAuthorityRegistration: issuer.registration,
    async inspect(request: ContractSourceVerificationRequest): Promise<ContractSourceVerification> {
      const reference = requestReference(request);
      const observationAuthority = issuer.issue(reference);
      const unavailable = (): ContractSourceVerification => Object.freeze({
        status: "unavailable",
        reference,
        observationAuthority,
      });
      if (request.signal.aborted) throw abortError();
      if (activeRequests >= sourcifyMaximumActiveRequests) return unavailable();
      activeRequests += 1;

      const controller = new AbortController();
      const requestSignal = AbortSignal.any([request.signal, controller.signal]);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let removeCallerAbort = (): void => undefined;
      const callerAborted = new Promise<Readonly<{ readonly kind: "caller_aborted" }>>((resolve) => {
        const listener = (): void => {
          controller.abort();
          resolve(Object.freeze({ kind: "caller_aborted" }));
        };
        if (request.signal.aborted) {
          listener();
        } else {
          request.signal.addEventListener("abort", listener, { once: true });
          removeCallerAbort = (): void => request.signal.removeEventListener("abort", listener);
        }
      });
      const timedOut = new Promise<Readonly<{ readonly kind: "timed_out" }>>((resolve) => {
        deadline = setTimeout(() => {
          resolve(Object.freeze({ kind: "timed_out" }));
          controller.abort();
        }, sourcifyRequestDeadlineMilliseconds);
      });
      const operation = (async (): Promise<ContractSourceVerification> => {
        const response = await fetchImplementation(reference.uri, {
          method: "GET",
          redirect: "error",
          signal: requestSignal,
          headers: Object.freeze({ accept: "application/json" }),
        });
        if (response.status !== 200 && response.status !== 404) {
          cancelResponseBody(response);
          return unavailable();
        }
        const body = await readResponseBody(response, requestSignal);
        if (body.status === "unavailable") return unavailable();
        if (body.status === "inconsistent") {
          return Object.freeze({ status: "inconsistent", reference, observationAuthority });
        }
        return classifyResponse(
          response,
          body.value,
          request,
          reference,
          observationAuthority,
        );
      })().finally(() => {
        activeRequests -= 1;
      });
      const operationOutcome = operation.then(
        (value) => Object.freeze({ kind: "completed" as const, value }),
        (error: unknown) => Object.freeze({ kind: "failed" as const, error }),
      );

      try {
        const outcome = await Promise.race([operationOutcome, callerAborted, timedOut]);
        if (outcome.kind === "caller_aborted") throw abortError();
        if (outcome.kind === "timed_out") return unavailable();
        if (outcome.kind === "failed") {
          if (request.signal.aborted) throw abortError();
          return unavailable();
        }
        return outcome.value;
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        removeCallerAbort();
      }
    },
  });

  return Object.freeze({
    port,
    observationAuthorityRegistration: issuer.registration,
  });
};
