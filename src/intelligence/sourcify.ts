import {
  captureCanonicalJson,
  compareCodePointSequences,
  contractControlInterfaceDefinitions,
  contractDeclaredFunctionUtf16CodeUnitLimit,
  createObservationAuthorityIssuer,
  deriveEip155Reference,
  exactContractInterfaceSchema,
  parseEvmAddress,
  parseHexBytes,
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
  formatAbiItem(item: Readonly<Record<string, unknown>>): string;
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

const assertAbiParameters = (
  value: CanonicalJson | undefined,
  eventInputs: boolean,
): void => {
  if (!Array.isArray(value)) throw new TypeError("Sourcify ABI parameters are invalid.");
  for (const parameter of value) {
    if (!isJsonObject(parameter) || readString(parameter["type"]) === undefined) {
      throw new TypeError("Sourcify ABI parameter is invalid.");
    }
    if (
      eventInputs &&
      parameter["indexed"] !== undefined &&
      typeof parameter["indexed"] !== "boolean"
    ) {
      throw new TypeError("Sourcify ABI event parameter is invalid.");
    }
    const components = parameter["components"];
    if (components !== undefined) assertAbiParameters(components, false);
  }
};

const assertAbiEntry = (entry: JsonObject): void => {
  const type = readString(entry["type"]);
  if (type === "function") {
    if (
      readString(entry["name"]) === undefined ||
      !["pure", "view", "nonpayable", "payable"].includes(
        readString(entry["stateMutability"]) ?? "",
      )
    ) throw new TypeError("Sourcify ABI function is invalid.");
    assertAbiParameters(entry["inputs"], false);
    assertAbiParameters(entry["outputs"], false);
    return;
  }
  if (type === "event") {
    if (
      readString(entry["name"]) === undefined ||
      (entry["anonymous"] !== undefined && typeof entry["anonymous"] !== "boolean")
    ) throw new TypeError("Sourcify ABI event is invalid.");
    assertAbiParameters(entry["inputs"], true);
    return;
  }
  if (type === "error") {
    if (readString(entry["name"]) === undefined) {
      throw new TypeError("Sourcify ABI error is invalid.");
    }
    assertAbiParameters(entry["inputs"], false);
    return;
  }
  if (type === "constructor") {
    if (!["nonpayable", "payable"].includes(readString(entry["stateMutability"]) ?? "")) {
      throw new TypeError("Sourcify ABI constructor is invalid.");
    }
    assertAbiParameters(entry["inputs"], false);
    return;
  }
  if (
    (type === "fallback" || type === "receive") &&
    ["nonpayable", "payable"].includes(readString(entry["stateMutability"]) ?? "")
  ) return;
  throw new TypeError("Sourcify ABI entry is invalid.");
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

const readResponseBody = async (
  response: Response,
  signal: AbortSignal,
): Promise<
  | Readonly<{ readonly status: "admitted"; readonly value: CanonicalJson }>
  | Readonly<{ readonly status: "inconsistent" }>
  | Readonly<{ readonly status: "unavailable" }>
> => {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    return Object.freeze({ status: "inconsistent" });
  }
  if (response.body === null) return Object.freeze({ status: "inconsistent" });
  if (signal.aborted) throw signal.reason;
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
      try {
        await reader.cancel(failure);
      } catch {
        // Preserve the response failure while consuming cleanup rejection.
      }
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
    return Object.freeze({
      status: "admitted",
      value: captureCanonicalJson(JSON.parse(text)),
    });
  } catch {
    return Object.freeze({ status: "inconsistent" });
  }
};

const sameInputs = (
  inputs: CanonicalJson | undefined,
  expected: readonly Readonly<{ readonly type: string; readonly indexed?: boolean }>[],
  event: boolean,
): boolean => {
  if (!Array.isArray(inputs) || inputs.length !== expected.length) return false;
  return inputs.every((input, index) => {
    if (!isJsonObject(input)) return false;
    const expectedInput = expected[index];
    if (expectedInput === undefined || readString(input["type"]) !== expectedInput.type) return false;
    if (!event) return true;
    return input["indexed"] === (expectedInput.indexed ?? false);
  });
};

const sameOutputs = (
  outputs: CanonicalJson | undefined,
  expected: readonly Readonly<{ readonly type: string }>[],
): boolean =>
  Array.isArray(outputs) &&
  outputs.length === expected.length &&
  outputs.every((output, index) =>
    isJsonObject(output) &&
    readString(output["type"]) === expected[index]?.type);

const matchesFunction = (
  entries: readonly JsonObject[],
  expected: ContractControlFunctionDefinition,
): boolean => entries.some((entry) =>
  entry["type"] === "function" &&
  entry["name"] === expected.name &&
  sameInputs(entry["inputs"], expected.inputs, false) &&
  sameOutputs(entry["outputs"], expected.outputs) &&
  expected.stateMutability.includes(readString(entry["stateMutability"]) as never));

const matchesEvent = (
  entries: readonly JsonObject[],
  expected: ContractControlEventDefinition,
): boolean => entries.some((entry) =>
  entry["type"] === "event" &&
  entry["name"] === expected.name &&
  entry["anonymous"] !== true &&
  sameInputs(entry["inputs"], expected.inputs, true));

const functionSignature = (entry: JsonObject): string => {
  const signature = sourcifyAbiFormat.formatAbiItem(entry);
  if (
    signature.length === 0 ||
    signature.length > contractDeclaredFunctionUtf16CodeUnitLimit ||
    !signature.includes("(") ||
    !signature.endsWith(")")
  ) {
    throw new TypeError("Sourcify ABI function format is invalid.");
  }
  return signature;
};

const exactContractInterface = (
  abiInput: CanonicalJson | undefined,
): ExactContractInterface => {
  if (!Array.isArray(abiInput)) throw new TypeError("Sourcify ABI is invalid.");
  const entries: JsonObject[] = abiInput.map((entry) => {
    if (!isJsonObject(entry)) throw new TypeError("Sourcify ABI entry is invalid.");
    assertAbiEntry(entry);
    sourcifyAbiFormat.formatAbiItem(entry);
    return entry;
  });
  const signatures = entries
    .filter((entry) => entry["type"] === "function")
    .map(functionSignature)
    .sort(compareCodePointSequences);
  if (new Set(signatures).size !== signatures.length) {
    throw new TypeError("Sourcify ABI contains duplicate function signatures.");
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

  return Object.freeze(exactContractInterfaceSchema.parse({
    declaredFunctions: Object.freeze(signatures),
    owner,
    paused,
    defaultAdmins: !hasDefaultAdminBase
      ? "not_declared"
      : hasDefaultAdminEnumeration
        ? "enumerable"
        : "not_enumerable",
  }));
};

const responseIdentityMatches = (
  value: JsonObject,
  request: ContractSourceVerificationRequest,
): boolean => {
  const chainId = readString(value["chainId"]);
  const address = readString(value["address"]);
  if (chainId !== deriveEip155Reference(request.chainId) || address === undefined) return false;
  try {
    return parseEvmAddress(address.toLowerCase()) === request.address;
  } catch {
    return false;
  }
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
  try {
    const onchainBytecode = parseHexBytes(runtimeBytecode["onchainBytecode"]);
    if (onchainBytecode !== request.runtimeBytecode) {
      return Object.freeze({ status: "inconsistent", reference, observationAuthority });
    }
    const exactInterface = exactContractInterface(value["abi"]);
    return Object.freeze({
      status: "exact_match",
      reference,
      observationAuthority,
      exactInterface,
    });
  } catch {
    return Object.freeze({ status: "inconsistent", reference, observationAuthority });
  }
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
  const fetchImplementation = input.fetch ?? fetch;
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
          await response.body?.cancel().catch(() => undefined);
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
