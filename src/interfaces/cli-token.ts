import {
  blockSelectorSchema,
  canonicalJsonStringify,
  captureCanonicalJson,
  getCapabilityDefinitionSnapshot,
  parseCapabilityInput,
  parseCapabilitySuccess,
  parseEvmAddressInput,
  type ApplicationFailure,
  type BlockSelector,
  type CanonicalJson,
  type EvmAddress,
  type EvmChainId,
} from "../core/index.js";
import {
  tokenCatalogApplicationContracts,
  createTokenCatalogFailure,
  tokenCatalogInterfaceErrorMappings,
  tokenCatalogOperationConfirmationContract,
  tokenCatalogOperationIdSchema,
  tokenRegistrationRevisionSchema,
  type AnyTokenCatalogApplicationContract,
  type TokenCatalogOperation,
  type TokenCatalogOperationStartResult,
  type TokenRegistration,
  type TokenRegistrationWithInspection,
} from "../token-catalog/index.js";
import type { RuntimeDispatchPort } from "./http-client.js";
import {
  LocalOperationClient,
  type LocalOperationIdentity,
} from "./operation-client.js";
import {
  deliveryUnknownCliExitCode,
  type DeliveryUnknown,
} from "./operation-delivery.js";
import {
  constrainInterfaceFailure,
  createInterfaceFailure,
  dispatchCanonical,
  type InterfaceInvocationResult,
} from "./http-client.js";
import {
  chainStatusInterface,
  tokenCatalogInterfaceBindings,
  tokenLocalOperationIdentities,
  tokenInspectInterface,
} from "./identities.js";

export type TokenCliCommand =
  | Readonly<{ kind: "inspect"; address: EvmAddress; block: BlockSelector; json: boolean }>
  | Readonly<{ kind: "get"; address: EvmAddress; json: boolean }>
  | Readonly<{ kind: "list"; limit?: number; cursor?: EvmAddress; json: boolean }>
  | Readonly<{ kind: "register"; address: EvmAddress; json: false }>
  | Readonly<{
      kind: "unregister";
      address: EvmAddress;
      expectedRevision: TokenRegistration["revision"];
      json: false;
    }>
  | Readonly<{ kind: "operation"; operationId: TokenCatalogOperation["operationId"]; json: boolean }>
  | Readonly<{ kind: "cancel"; operationId: TokenCatalogOperation["operationId"]; json: boolean }>;

export interface TokenCliOutputPort {
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
  readonly interruptSignal: AbortSignal;
  writeOutput(value: string): void;
  writeError(value: string): void;
  readLine(prompt: string): Promise<string>;
}

interface ParsedTokens {
  readonly json: boolean;
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

const invalidInput = (): never => { throw new TypeError("Token CLI input is invalid."); };

const parseTokens = (
  tokens: readonly string[],
  allowedValues: ReadonlySet<string>,
  allowedBooleans: ReadonlySet<string> = new Set(),
  allowJson = false,
): ParsedTokens => {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  let json = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) throw new TypeError("Token CLI input is invalid.");
    if (token === "--json") {
      if (!allowJson || json) invalidInput();
      json = true;
      continue;
    }
    if (token?.startsWith("--")) {
      if (allowedBooleans.has(token)) {
        if (booleans.has(token)) invalidInput();
        booleans.add(token);
        continue;
      }
      if (!allowedValues.has(token) || values.has(token)) invalidInput();
      const value = tokens[index + 1];
      if (value === undefined) {
        throw new TypeError("Token CLI input is invalid.");
      }
      values.set(token, value);
      index += 1;
      continue;
    }
    positionals.push(token);
  }
  return Object.freeze({
    json,
    positionals: Object.freeze(positionals),
    values: new Map(values),
    booleans: new Set(booleans),
  });
};

const address = (value: string | undefined): EvmAddress => {
  if (value === undefined) return invalidInput();
  try { return parseEvmAddressInput(value); }
  catch { return invalidInput(); }
};

const operationId = (
  value: string | undefined,
): TokenCatalogOperation["operationId"] => {
  try { return tokenCatalogOperationIdSchema.parse(value); }
  catch { return invalidInput(); }
};

const revision = (
  value: string | undefined,
): TokenRegistration["revision"] => {
  try { return tokenRegistrationRevisionSchema.parse(value); }
  catch { return invalidInput(); }
};

const block = (value: string | undefined): BlockSelector => {
  if (value === "latest") return blockSelectorSchema.parse({ kind: "latest" });
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return invalidInput();
  try { return blockSelectorSchema.parse({ kind: "number", blockNumber: value }); }
  catch { return invalidInput(); }
};

const position = (parsed: ParsedTokens): string => {
  if (parsed.positionals.length !== 1) return invalidInput();
  return parsed.positionals[0] as string;
};

const parseLimit = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^(?:[1-9]|1[0-9]|2[0-5])$/.test(value)) return invalidInput();
  return Number(value);
};

export const parseTokenCliCommand = (argumentsInput: readonly string[]): TokenCliCommand => {
  const [domain, command, ...tokens] = argumentsInput;
  if (domain !== "token" || command === undefined) return invalidInput();
  if (command === tokenInspectInterface.cli.command) {
    const parsed = parseTokens(tokens, new Set(["--block"]), new Set(), true);
    if (!parsed.values.has("--block")) return invalidInput();
    return Object.freeze({
      kind: "inspect",
      address: address(position(parsed)),
      block: block(parsed.values.get("--block")),
      json: parsed.json,
    });
  }
  if (command === tokenCatalogInterfaceBindings.registration.cli.command) {
    const parsed = parseTokens(tokens, new Set(), new Set(), true);
    return Object.freeze({ kind: "get", address: address(position(parsed)), json: parsed.json });
  }
  if (command === tokenCatalogInterfaceBindings.registrations.cli.command) {
    const parsed = parseTokens(tokens, new Set(["--limit", "--cursor"]), new Set(), true);
    if (parsed.positionals.length !== 0) return invalidInput();
    const limit = parseLimit(parsed.values.get("--limit"));
    const cursorValue = parsed.values.get("--cursor");
    return Object.freeze({
      kind: "list",
      ...(limit === undefined ? {} : { limit }),
      ...(cursorValue === undefined ? {} : { cursor: address(cursorValue) }),
      json: parsed.json,
    });
  }
  if (command === tokenCatalogInterfaceBindings.startRegistration.cli.command) {
    const parsed = parseTokens(tokens, new Set());
    return Object.freeze({
      kind: "register",
      address: address(position(parsed)),
      json: false,
    });
  }
  if (command === tokenCatalogInterfaceBindings.startUnregistration.cli.command) {
    const parsed = parseTokens(tokens, new Set(["--revision"]));
    return Object.freeze({
      kind: "unregister",
      address: address(position(parsed)),
      expectedRevision: revision(parsed.values.get("--revision")),
      json: false,
    });
  }
  if (command === tokenCatalogInterfaceBindings.operation.cli.command ||
    command === tokenCatalogInterfaceBindings.cancelOperation.cli.command) {
    const parsed = parseTokens(tokens, new Set(), new Set(), true);
    return Object.freeze({
      kind: command === tokenCatalogInterfaceBindings.operation.cli.command ? "operation" : "cancel",
      operationId: operationId(position(parsed)),
      json: parsed.json,
    });
  }
  return invalidInput();
};

export const tokenCliCommandRequiresInteractiveTerminal = (
  command: TokenCliCommand,
): boolean => command.kind === "register" || command.kind === "unregister";

const canonical = (output: TokenCliOutputPort, value: unknown): void => {
  output.writeOutput(`${canonicalJsonStringify(captureCanonicalJson(value))}\n`);
};

const reportFailure = (
  output: TokenCliOutputPort,
  failure: ApplicationFailure,
  json: boolean,
): number => {
  if (json) canonical(output, failure);
  else output.writeError(`${failure.error.code}: ${failure.error.message}\n`);
  return tokenCatalogInterfaceErrorMappings.get(failure.error.code).cliExitCode;
};

class TokenCliDeliveryUnknown extends Error {
  readonly delivery: DeliveryUnknown;

  constructor(delivery: DeliveryUnknown) {
    super("The local operation response is unavailable after sending began.");
    this.name = "TokenCliDeliveryUnknown";
    this.delivery = delivery;
    Object.freeze(this);
  }
}

const invokeLocal = async <Input, Success>(
  client: LocalOperationClient,
  identity: LocalOperationIdentity<Input, Success>,
  input: unknown,
  signal?: AbortSignal,
): Promise<InterfaceInvocationResult> => {
  const result = await client.invoke(identity, input, signal);
  if ("status" in result) throw new TokenCliDeliveryUnknown(result);
  return result.ok
    ? Object.freeze({ ok: true, value: captureCanonicalJson(result.value) })
    : result;
};

const configuredChainId = async (
  runtime: RuntimeDispatchPort,
  signal: AbortSignal,
): Promise<EvmChainId | ApplicationFailure> => {
  const result = constrainInterfaceFailure(await dispatchCanonical(runtime, {
    requestClass: "public_read",
    method: chainStatusInterface.http.method,
    path: chainStatusInterface.http.path,
    signal,
  }, 200, chainStatusInterface.responseAuthority), getCapabilityDefinitionSnapshot(chainStatusInterface.definition).failureCodes);
  if (!result.ok) return result.failure;
  try { return parseCapabilitySuccess(chainStatusInterface.definition, {}, result.value).data.chainId; }
  catch { return createInterfaceFailure("internal_error"); }
};

const asset = (chainId: EvmChainId, tokenAddress: EvmAddress) => Object.freeze({
  kind: "erc20" as const,
  chainId,
  address: tokenAddress,
});

const observationText = (
  observation: TokenRegistrationWithInspection["inspection"]["data"]["metadata"]["name"],
): string => observation.status === "available"
  ? observation.value
  : `unavailable (${observation.reason})`;

const decimalsText = (
  decimals: TokenRegistrationWithInspection["inspection"]["data"]["totalSupply"]["decimals"],
): string => decimals.status === "available"
  ? decimals.value
  : decimals.status === "unavailable"
    ? `unavailable (${decimals.reason})`
    : `not observed (${decimals.scopeExclusionId})`;

const inspectionHuman = (inspection: TokenRegistrationWithInspection["inspection"]): string => {
  const data = inspection.data;
  return [
    `Token: ${data.asset.address}`,
    `Chain: ${data.asset.chainId}`,
    `Block number: ${data.block.blockNumber}`,
    `Block hash: ${data.block.blockHash}`,
    `Block timestamp: ${data.block.blockTimestamp}`,
    `Runtime code bytes: ${data.runtimeCode.byteLength}`,
    `Runtime code hash: ${data.runtimeCode.codeHash}`,
    `Name: ${observationText(data.metadata.name)}`,
    `Symbol: ${observationText(data.metadata.symbol)}`,
    `Decimals: ${decimalsText(data.totalSupply.decimals)}`,
    `Total supply: ${data.totalSupply.raw}`,
    `Inspected at: ${inspection.meta.evaluatedAt}`,
    `Evidence coverage: ${inspection.evidence.coverage.status}`,
    `Evidence sources: ${inspection.evidence.sources.length}`,
    `Evidence conclusions: ${inspection.evidence.conclusions.length}`,
    `Warnings: ${inspection.warnings.length === 0
      ? "none"
      : inspection.warnings.map((warning) => warning.message).join("; ")}`,
  ].join("\n");
};

const registrationHuman = (registration: TokenRegistration): string => [
  `Token: ${registration.asset.address}`,
  `Chain: ${registration.asset.chainId}`,
  `Revision: ${registration.revision}`,
].join("\n");

const operationAction = (operation: TokenCatalogOperation): string => {
  switch (operation.kind) {
    case "register": return "Add token";
    case "unregister": return "Remove token";
  }
};

const operationReviewHuman = (operation: TokenCatalogOperation): string => {
  const previous = operation.review.previousRegistration;
  return [
    operationAction(operation),
    `Token: ${operation.asset.address}`,
    `Chain: ${operation.asset.chainId}`,
    ...(previous === null ? [] : [
      `Current registration revision: ${previous.revision}`,
    ]),
    "",
    "Reviewed token inspection",
    inspectionHuman(operation.review.inspection),
  ].join("\n");
};

const operationOutcomeHuman = (operation: TokenCatalogOperation): string => operation.state === "completed"
    ? operation.kind === "register"
      ? "Token added."
      : "Token removed."
    : operation.state === "cancelled"
      ? "Token catalog change cancelled."
      : `Token catalog operation: ${operation.state}.`;

const operationHuman = (operation: TokenCatalogOperation): string =>
  `${operationReviewHuman(operation)}\n${operationOutcomeHuman(operation)}`;

type ConfirmationDecision = "confirm" | "decline" | "interrupt";

const confirmationDecision = async (
  output: TokenCliOutputPort,
): Promise<ConfirmationDecision> => {
  if (output.interruptSignal.aborted) return "interrupt";
  let resolveInterrupt!: () => void;
  const interrupted = new Promise<"interrupt">((resolve) => { resolveInterrupt = () => resolve("interrupt"); });
  const onAbort = (): void => { resolveInterrupt(); };
  output.interruptSignal.addEventListener("abort", onAbort, { once: true });
  try {
    const answer = output.readLine("Confirm this token catalog change? [y/N] ")
      .then((value): ConfirmationDecision => /^y$/iu.test(value) ? "confirm" : "decline");
    return await Promise.race([answer, interrupted]);
  } finally {
    output.interruptSignal.removeEventListener("abort", onAbort);
  }
};

const startInput = async (
  runtime: RuntimeDispatchPort,
  command: Extract<TokenCliCommand, { kind: "register" | "unregister" }>,
  signal: AbortSignal,
): Promise<Readonly<{
  contract: AnyTokenCatalogApplicationContract;
  request: Readonly<Record<string, CanonicalJson>>;
  operationKind: "register" | "unregister";
}> | ApplicationFailure> => {
  const chainId = await configuredChainId(runtime, signal);
  if (typeof chainId !== "string") return chainId;
  const tokenAsset = asset(chainId, command.address);
  if (command.kind === "register") {
    const contract = tokenCatalogApplicationContracts.startRegistration;
    return Object.freeze({
      contract,
      request: contract.parseInput({ asset: tokenAsset }) as unknown as Readonly<Record<string, CanonicalJson>>,
      operationKind: "register" as const,
    });
  }
  const contract = tokenCatalogApplicationContracts.startUnregistration;
  return Object.freeze({
    contract,
    request: contract.parseInput({ asset: tokenAsset, expectedRevision: command.expectedRevision }) as unknown as Readonly<Record<string, CanonicalJson>>,
    operationKind: "unregister" as const,
  });
};

const cancelStartedOperation = async (
  client: LocalOperationClient,
  operation: TokenCatalogOperation,
): Promise<InterfaceInvocationResult> => invokeLocal(
  client,
  tokenLocalOperationIdentities.shared.cancel,
  { operationId: operation.operationId },
);

const runInteractiveChange = async (
  runtime: RuntimeDispatchPort,
  client: LocalOperationClient,
  command: Extract<TokenCliCommand, { kind: "register" | "unregister" }>,
  output: TokenCliOutputPort,
): Promise<number> => {
  const prepared = await startInput(runtime, command, output.interruptSignal);
  if (!("contract" in prepared)) return reportFailure(output, prepared, false);
  if (output.interruptSignal.aborted) {
    return reportFailure(output, createInterfaceFailure("request_aborted"), false);
  }
  const start = prepared.operationKind === "register"
    ? await invokeLocal(
      client,
      tokenLocalOperationIdentities.cli.registration,
      prepared.request,
      output.interruptSignal,
    )
    : await invokeLocal(
        client,
        tokenLocalOperationIdentities.cli.unregistration,
        prepared.request,
        output.interruptSignal,
      );
  if (!start.ok) return reportFailure(output, start.failure, false);
  const started = start.value as unknown as TokenCatalogOperationStartResult;
  if (output.interruptSignal.aborted) {
    const cancelled = await cancelStartedOperation(client, started.operation);
    if (!cancelled.ok) return reportFailure(output, cancelled.failure, false);
    return 0;
  }
  output.writeOutput(`${operationReviewHuman(started.operation)}\n`);
  let decision: ConfirmationDecision;
  let confirmationInputFailed = false;
  try { decision = await confirmationDecision(output); }
  catch {
    confirmationInputFailed = true;
    decision = "decline";
  }
  if (decision !== "confirm" || output.interruptSignal.aborted) {
    const cancelled = await cancelStartedOperation(client, started.operation);
    if (!cancelled.ok) return reportFailure(output, cancelled.failure, false);
    const operation = (cancelled.value as unknown as { operation: TokenCatalogOperation }).operation;
    if (confirmationInputFailed) {
      return reportFailure(output, createInterfaceFailure("internal_error"), false);
    }
    output.writeOutput(`${operationOutcomeHuman(operation)}\n`);
    return 0;
  }
  const confirmationInput = tokenCatalogOperationConfirmationContract.parseInput({
    operationId: started.operation.operationId,
    reviewDigest: started.operation.review.reviewDigest,
  });
  const constrained = await invokeLocal(
    client,
    tokenLocalOperationIdentities.cli.confirm,
    confirmationInput,
    output.interruptSignal,
  );
  if (!constrained.ok) return reportFailure(output, constrained.failure, false);
  let operation: TokenCatalogOperation;
  try {
    operation = tokenCatalogOperationConfirmationContract.parsePublicSuccess(
      confirmationInput,
      constrained.value,
    );
  } catch {
    return reportFailure(output, createInterfaceFailure("internal_error"), false);
  }
  if (operation.state === "failed") return reportFailure(output, operation.failure, false);
  output.writeOutput(`${operationOutcomeHuman(operation)}\n`);
  return 0;
};

export const runTokenCliCommand = async (
  runtime: RuntimeDispatchPort,
  client: LocalOperationClient,
  command: TokenCliCommand,
  output: TokenCliOutputPort,
): Promise<number> => {
  try {
    if (tokenCliCommandRequiresInteractiveTerminal(command) &&
      (!output.inputIsTTY || !output.outputIsTTY)) {
      return reportFailure(output, createTokenCatalogFailure("interactive_terminal_required"), false);
    }
    if (command.kind === "register" || command.kind === "unregister") {
      return await runInteractiveChange(runtime, client, command, output);
    }
    if (command.kind === "operation" || command.kind === "cancel") {
      const contract = command.kind === "operation"
        ? tokenCatalogApplicationContracts.operation
        : tokenCatalogApplicationContracts.cancelOperation;
      const input = contract.parseInput({ operationId: command.operationId });
      const result = await invokeLocal(
        client,
        command.kind === "operation"
          ? tokenLocalOperationIdentities.shared.operation
          : tokenLocalOperationIdentities.shared.cancel,
        input,
        output.interruptSignal,
      );
      if (!result.ok) return reportFailure(output, result.failure, command.json);
      if (command.json) canonical(output, result.value);
      else output.writeOutput(`${operationHuman(
        (result.value as unknown as { operation: TokenCatalogOperation }).operation,
      )}\n`);
      return 0;
    }
    if (command.kind === "list") {
      const contract = tokenCatalogApplicationContracts.registrations;
      const input = {
        ...(command.limit === undefined ? {} : { limit: command.limit }),
        ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
      };
      const result = await invokeLocal(
        client,
        tokenLocalOperationIdentities.shared.registrations,
        input,
        output.interruptSignal,
      );
      if (!result.ok) return reportFailure(output, result.failure, command.json);
      if (command.json) canonical(output, result.value);
      else {
        const page = result.value as unknown as { registrations: TokenRegistration[]; nextCursor: string | null };
        output.writeOutput(page.registrations.length === 0
          ? "No tokens are registered for the current wallet account.\n"
          : `${page.registrations.map(registrationHuman).join("\n\n")}${
              page.nextCursor === null ? "" : `\n\nNext cursor: ${page.nextCursor}`
            }\n`);
      }
      return 0;
    }
    const chainId = await configuredChainId(runtime, output.interruptSignal);
    if (typeof chainId !== "string") return reportFailure(output, chainId, command.json);
    const tokenAsset = asset(chainId, command.address);
    if (command.kind === "inspect") {
      const input = parseCapabilityInput(
        tokenInspectInterface.definition,
        { asset: tokenAsset, block: command.block },
      );
      const result = constrainInterfaceFailure(await dispatchCanonical(runtime, {
        requestClass: "public_read",
        method: tokenInspectInterface.http.method,
        path: tokenInspectInterface.http.path,
        body: captureCanonicalJson(input),
        signal: output.interruptSignal,
      }, 200, tokenInspectInterface.responseAuthority), getCapabilityDefinitionSnapshot(tokenInspectInterface.definition).failureCodes);
      if (!result.ok) return reportFailure(output, result.failure, command.json);
      try {
        const success = parseCapabilitySuccess(tokenInspectInterface.definition, input, result.value);
        if (command.json) canonical(output, success);
        else output.writeOutput(`${inspectionHuman(success)}\n`);
        return 0;
      } catch {
        return reportFailure(output, createInterfaceFailure("internal_error"), command.json);
      }
    }
    const contract = tokenCatalogApplicationContracts.registration;
    const input = contract.parseInput({ asset: tokenAsset });
    const result = await invokeLocal(
      client,
      tokenLocalOperationIdentities.shared.registration,
      input,
      output.interruptSignal,
    );
    if (!result.ok) return reportFailure(output, result.failure, command.json);
    const registration = result.value as unknown as TokenRegistrationWithInspection;
    if (command.json) canonical(output, registration);
    else output.writeOutput(`${registrationHuman(registration.registration)}\n${inspectionHuman(registration.inspection)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof TokenCliDeliveryUnknown) {
      if (command.json) canonical(output, error.delivery);
      else output.writeError([
        `Delivery unknown for ${error.delivery.action} operation ${error.delivery.operationId}.`,
        "The action may have occurred. Do not repeat it.",
        "Inspect that exact operation before another state change.",
        "",
      ].join("\n"));
      return deliveryUnknownCliExitCode;
    }
    return reportFailure(output, createInterfaceFailure("internal_error"), command.json);
  }
};
