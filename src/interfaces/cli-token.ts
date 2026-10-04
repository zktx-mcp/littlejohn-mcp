import {blockSelectorSchema, type BlockSelector} from "../evm/primitives.js";
import {canonicalJsonStringify, captureCanonicalJson, getCapabilityDefinitionSnapshot, parseCapabilityInput, parseCapabilitySuccess, type ApplicationFailure} from "../core/index.js";
import {parseEvmAddressInput} from "../evm/address-input.js";
import {type AddressTarget} from "../evm/address-target.js";
import {type EvmAddress, type EvmChainId} from "../evm/identities.js";
import {
  tokenCatalogApplicationContracts,
  tokenCatalogContractLimits,
  tokenCatalogOperationIdSchema,
  tokenSelectionRevisionSchema,
  type TokenCatalogOperation,
  type TokenSelection,
  type TokenSelectionDetail,
  type TokenSelectionReview,
} from "../token-catalog/client.js";
import {
  createTokenCatalogFailure,
  tokenCatalogInterfaceErrorMappings,
} from "../token-catalog/errors.js";
import type { RuntimeDispatchPort } from "./http-client.js";
import {
  LocalOperationClient,
  type LocalOperationIdentity,
} from "./operation-client.js";
import {
  type DeliveryUnknown,
} from "./operation-delivery.js";
import { deliveryUnknownCliExitCode } from "./delivery-exit.js";
import {
  constrainInterfaceFailure,
  createInterfaceFailure,
  dispatchCanonical,
  type InterfaceInvocationResult,
} from "./http-client.js";
import {
  chainStatusInterface,
  tokenCatalogInterfaceBindings,
  tokenLocalReadIdentities,
  tokenInspectInterface,
} from "./identities.js";
import { contractAnalysisHumanLines } from "./cli-contract-analysis.js";
import { runAtomicCliDecision } from "./cli-operation.js";
import { operationInterfaceBindings } from "./operation-bindings.js";

export type TokenCliCommand =
  | Readonly<{ kind: "inspect"; address: EvmAddress; block: BlockSelector; json: boolean }>
  | Readonly<{ kind: "get"; account: AddressTarget; address: EvmAddress; json: boolean }>
  | Readonly<{ kind: "list"; account: AddressTarget; limit?: number; cursor?: EvmAddress; json: boolean }>
  | Readonly<{ kind: "add"; account: AddressTarget; address: EvmAddress; json: false }>
  | Readonly<{
      kind: "remove";
      account: AddressTarget;
      address: EvmAddress;
      expectedRevision: TokenSelection["revision"];
      json: false;
    }>
  | Readonly<{ kind: "operation"; operationId: TokenCatalogOperation["operationId"]; json: boolean }>;

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
): TokenSelection["revision"] => {
  try { return tokenSelectionRevisionSchema.parse(value); }
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
  if (!/^[1-9][0-9]*$/u.test(value)) return invalidInput();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > tokenCatalogContractLimits.listMaximumLimit) {
    return invalidInput();
  }
  return limit;
};

const accountTarget = (parsed: ParsedTokens): AddressTarget => {
  const active = parsed.booleans.has("--active");
  const explicit = parsed.values.get("--address");
  if (active === (explicit !== undefined)) return invalidInput();
  return active
    ? Object.freeze({ kind: "active_wallet" })
    : Object.freeze({ kind: "address", address: address(explicit) });
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
  if (command === tokenCatalogInterfaceBindings.selection.cli.command) {
    const parsed = parseTokens(tokens, new Set(["--address"]), new Set(["--active"]), true);
    return Object.freeze({
      kind: "get",
      account: accountTarget(parsed),
      address: address(position(parsed)),
      json: parsed.json,
    });
  }
  if (command === tokenCatalogInterfaceBindings.selections.cli.command) {
    const parsed = parseTokens(
      tokens,
      new Set(["--address", "--limit", "--cursor"]),
      new Set(["--active"]),
      true,
    );
    if (parsed.positionals.length !== 0) return invalidInput();
    const limit = parseLimit(parsed.values.get("--limit"));
    const cursorValue = parsed.values.get("--cursor");
    return Object.freeze({
      kind: "list",
      account: accountTarget(parsed),
      ...(limit === undefined ? {} : { limit }),
      ...(cursorValue === undefined ? {} : { cursor: address(cursorValue) }),
      json: parsed.json,
    });
  }
  if (command === operationInterfaceBindings.tokenAdd.cli?.command) {
    const parsed = parseTokens(tokens, new Set(["--address"]), new Set(["--active"]));
    return Object.freeze({
      kind: "add",
      account: accountTarget(parsed),
      address: address(position(parsed)),
      json: false,
    });
  }
  if (command === operationInterfaceBindings.tokenRemove.cli?.command) {
    const parsed = parseTokens(
      tokens,
      new Set(["--address", "--revision"]),
      new Set(["--active"]),
    );
    return Object.freeze({
      kind: "remove",
      account: accountTarget(parsed),
      address: address(position(parsed)),
      expectedRevision: revision(parsed.values.get("--revision")),
      json: false,
    });
  }
  if (command === operationInterfaceBindings.tokenOperation.cli?.command) {
    const parsed = parseTokens(tokens, new Set(), new Set(), true);
    return Object.freeze({
      kind: "operation",
      operationId: operationId(position(parsed)),
      json: parsed.json,
    });
  }
  return invalidInput();
};

export const tokenCliCommandRequiresInteractiveTerminal = (
  command: TokenCliCommand,
): boolean => command.kind === "add" || command.kind === "remove";

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
  if (chainStatusInterface.http.method !== "GET") return createInterfaceFailure("internal_error");
  const result = constrainInterfaceFailure(await dispatchCanonical(runtime, {
    requestClass: "public_read",
    method: "GET",
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

type HistoricalInspection = NonNullable<TokenSelectionDetail["historicalInspection"]>;

const observationText = (
  observation: HistoricalInspection["data"]["metadata"]["name"],
): string => observation.status === "available"
  ? observation.value
  : `unavailable (${observation.reason})`;

const decimalsText = (
  decimals: HistoricalInspection["data"]["totalSupply"]["decimals"],
): string => decimals.status === "available"
  ? decimals.value
  : decimals.status === "unavailable"
    ? `unavailable (${decimals.reason})`
    : `not observed (${decimals.scopeExclusionId})`;

const inspectionHuman = (inspection: HistoricalInspection): string => {
  const data = inspection.data;
  return [
    `Token: ${data.asset.address}`,
    `Chain: ${data.asset.chainId}`,
    `Block number: ${data.analysis.block.blockNumber}`,
    `Block hash: ${data.analysis.block.blockHash}`,
    `Block timestamp: ${data.analysis.block.blockTimestamp}`,
    ...contractAnalysisHumanLines(data.analysis),
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

const selectionHuman = (selection: TokenSelection): string => [
  `Account: ${selection.account.address}`,
  `Token: ${selection.asset.address}`,
  `Chain: ${selection.asset.chainId}`,
  `Revision: ${selection.revision}`,
].join("\n");

const reviewAction = (review: TokenSelectionReview): string => {
  switch (review.kind) {
    case "add": return "Add token";
    case "remove": return "Remove token";
  }
};

const reviewedText = (
  observation: Extract<TokenSelectionReview, { kind: "add" }>["decision"]["name"],
): string => observation.status === "available"
  ? observation.value
  : `unavailable (${observation.reason})`;

const tokenReviewHuman = (review: TokenSelectionReview): string => {
  const previous = review.precondition.previousSelection;
  return [
    reviewAction(review),
    `Token: ${review.target.asset.address}`,
    `Chain: ${review.target.asset.chainId}`,
    `Account: ${review.target.account.address}`,
    `Connection revision: ${review.precondition.accountTarget.kind === "active_wallet"
      ? review.precondition.accountTarget.connectionRevision
      : "not applicable"}`,
    `Current selection: ${previous === null
      ? "none"
      : `${previous.included ? "included" : "not included"}, revision ${previous.revision}`}`,
    `Selection-set revision: ${review.precondition.selectionSetRevision ?? "none"}`,
    ...(review.kind === "add" ? [
      `Name: ${reviewedText(review.decision.name)}`,
      `Symbol: ${reviewedText(review.decision.symbol)}`,
      `Classification: ${review.decision.officialClassification === "official"
        ? "Robinhood Stock Token"
        : "Unlisted ERC-20"}`,
      `Warnings: ${review.decision.warningCodes.join(", ") || "none"}`,
      `Inspection block: ${review.fixedEvidence.inspectionBlock.blockNumber} ` +
        `(${review.fixedEvidence.inspectionBlock.blockHash})`,
      `Official snapshot revision: ${review.fixedEvidence.officialSnapshotRevision}`,
      ...(review.fixedEvidence.officialEvidence === null ? [] : [
        `Official asset UID: ${review.fixedEvidence.officialEvidence.assetUid}`,
      ]),
    ] : []),
    `Action deadline: ${review.actionExpiresAt}`,
    `Operation ID: ${review.operationId}`,
    `Review digest: ${review.reviewDigest}`,
  ].join("\n");
};

const operationHuman = (operation: TokenCatalogOperation): string => [
  `Token selection operation ${operation.operationId}: completed`,
  `Action: ${operation.kind}`,
  `Outcome: ${operation.result.outcome}`,
  `Completed at: ${operation.completedAt}`,
  `Review digest: ${operation.review.reviewDigest}`,
  `Selection-set revision: ${operation.result.selectionSetRevision}`,
  selectionHuman(operation.result.selection.selection),
].join("\n");

const reviewInput = async (
  runtime: RuntimeDispatchPort,
  command: Extract<TokenCliCommand, { kind: "add" | "remove" }>,
  signal: AbortSignal,
): Promise<
  ReturnType<typeof tokenCatalogApplicationContracts.selectionChangeReview.parseInput> |
  ApplicationFailure
> => {
  const chainId = await configuredChainId(runtime, signal);
  if (typeof chainId !== "string") return chainId;
  const tokenAsset = asset(chainId, command.address);
  return tokenCatalogApplicationContracts.selectionChangeReview.parseInput(command.kind === "add"
    ? { kind: "add", account: command.account, asset: tokenAsset }
    : {
        kind: "remove",
        account: command.account,
        asset: tokenAsset,
        expectedRevision: command.expectedRevision,
      });
};

const runInteractiveChange = async (
  runtime: RuntimeDispatchPort,
  client: LocalOperationClient,
  command: Extract<TokenCliCommand, { kind: "add" | "remove" }>,
  output: TokenCliOutputPort,
): Promise<number> => {
  const prepared = await reviewInput(runtime, command, output.interruptSignal);
  if ("ok" in prepared) return reportFailure(output, prepared, false);
  if (output.interruptSignal.aborted) {
    return reportFailure(output, createInterfaceFailure("request_aborted"), false);
  }
  const binding = command.kind === "add"
    ? operationInterfaceBindings.tokenAdd
    : operationInterfaceBindings.tokenRemove;
  const decided = await runAtomicCliDecision({
    client,
    reviewIdentity: operationInterfaceBindings.tokenReview.identity,
    reviewInput: prepared,
    selectReview: (result) => result.review,
    actionIdentity: binding.identity,
    actionInput: (review) => binding.contract.parseInput({ review, initiatedBy: "cli" }) as never,
    formatReview: tokenReviewHuman,
    formatOperation: operationHuman,
    prompt: "Apply this account token change? [y/N] ",
    output,
  });
  if (decided.status === "completed" || decided.status === "declined") return 0;
  if (decided.status === "delivery_unknown") {
    throw new TokenCliDeliveryUnknown(decided.delivery);
  }
  return reportFailure(output, decided.failure, false);
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
    if (command.kind === "add" || command.kind === "remove") {
      return await runInteractiveChange(runtime, client, command, output);
    }
    if (command.kind === "operation") {
      const input = tokenCatalogApplicationContracts.operation.parseInput({
        operationId: command.operationId,
      });
      const result = await invokeLocal(
        client,
        operationInterfaceBindings.tokenOperation.identity,
        input,
        output.interruptSignal,
      );
      if (!result.ok) return reportFailure(output, result.failure, command.json);
      if (command.json) canonical(output, result.value);
      else output.writeOutput(`${operationHuman(result.value as unknown as TokenCatalogOperation)}\n`);
      return 0;
    }
    if (command.kind === "list") {
      const contract = tokenCatalogApplicationContracts.selections;
      const input = {
        account: command.account,
        ...(command.limit === undefined ? {} : { limit: command.limit }),
        ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
      };
      const result = await invokeLocal(
        client,
        tokenLocalReadIdentities.selections,
        input,
        output.interruptSignal,
      );
      if (!result.ok) return reportFailure(output, result.failure, command.json);
      if (command.json) canonical(output, result.value);
      else {
        const page = result.value as unknown as {
          account: TokenSelection["account"];
          selections: TokenSelection[];
          nextCursor: string | null;
        };
        output.writeOutput(page.selections.length === 0
          ? `No tokens are added for ${page.account.address}.\n`
          : `${page.selections.map(selectionHuman).join("\n\n")}${
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
      if (tokenInspectInterface.http.method !== "POST") {
        return reportFailure(output, createInterfaceFailure("internal_error"), command.json);
      }
      const result = constrainInterfaceFailure(await dispatchCanonical(runtime, {
        requestClass: "public_read",
        method: "POST",
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
    const contract = tokenCatalogApplicationContracts.selection;
    const input = contract.parseInput({ account: command.account, asset: tokenAsset });
    const result = await invokeLocal(
      client,
      tokenLocalReadIdentities.selection,
      input,
      output.interruptSignal,
    );
    if (!result.ok) return reportFailure(output, result.failure, command.json);
    const selection = result.value as unknown as TokenSelectionDetail;
    if (command.json) canonical(output, selection);
    else output.writeOutput(`${selectionHuman(selection.selection)}${
      selection.historicalInspection === null ? "" : `\n${inspectionHuman(selection.historicalInspection)}`
    }\n`);
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
