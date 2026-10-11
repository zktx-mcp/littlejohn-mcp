import {admitApplicationInput, canonicalJsonStringify, captureCanonicalJson, createApplicationFailure,
  type ApplicationFailure, type CanonicalJson, type CapabilityBindingRegistry} from "../core/index.js";
import type {PresentationSnapshotStore} from "../runtime/presentation-snapshot.js";
import {createApplicationLifecycle} from "../runtime/application-lifecycle.js";
import {getRuntimeOperationFailure, RuntimeOperationError} from "../runtime/errors.js";
import type {RuntimeRouteRegistry} from "../runtime/http-routing.js";
import {publicReadResponseLimitBytes} from "../runtime/http-limits.js";
import {accountAssetApplicationContracts, accountAssetCollectionRequestBody} from "../account-assets/client.js";
import type {AccountAssetApplicationPort} from "../account-assets/index.js";
import {normalizeAccountAssetError} from "../account-assets/errors.js";
import {tokenCatalogApplicationContracts, tokenSelectionListRequestBody} from "../token-catalog/client.js";
import type {TokenCatalogQueryApplicationPort} from "../token-catalog/ports.js";
import {normalizeTokenCatalogError} from "../token-catalog/operation-error.js";
import {receiptApplicationContracts, type ReceiptActivityPort} from "../receipt-activity/application-contracts.js";
import {normalizeReceiptActivityFailure} from "../receipt-activity/operation-error.js";
import {interfaceReadCapabilityRegistry} from "./identities.js";
import {PresentationWorkBudget} from "./presentation-work.js";
import {boundedSnapshotResource} from "./mcp-app/snapshot-record.js";
import {admitMcpToolResultForDelivery, createMcpSnapshotResult} from "./mcp-result.js";
import {formatImmutableReadResult, immutableReadContractRegistry, immutableReadResultContract,
  immutableReadResultIdentity, immutableReadInterfaceErrorMappings, type ImmutableReadInput, type ImmutableReadTransport} from "./immutable-read-contracts.js";

type ReadResult = {readonly ok: true; readonly value: CanonicalJson} | {readonly ok: false; readonly failure: ApplicationFailure};
export class ImmutableReadApplication {
  readonly #lifecycle = createApplicationLifecycle();
  readonly #calls = new Set<Promise<unknown>>();
  readonly #controllers = new Set<AbortController>();

  constructor(private readonly ports: Readonly<{
    signal: AbortSignal; work: PresentationWorkBudget; snapshots: PresentationSnapshotStore;
    bindings: CapabilityBindingRegistry; accountAssets: AccountAssetApplicationPort;
    token: TokenCatalogQueryApplicationPort; activity: ReceiptActivityPort;
  }>) {
    const abort = (): void => {for (const controller of this.#controllers) controller.abort();};
    ports.signal.addEventListener("abort", abort, {once: true});
    this.#lifecycle.resources.register({close: async () => {
      ports.signal.removeEventListener("abort", abort); abort(); await Promise.allSettled([...this.#calls]);
    }});
    this.#lifecycle.open();
  }

  // Card publication owns its live permit and durable card/source commit.
  executeCard(input: Readonly<{capabilityId: string; input: unknown}>, signal: AbortSignal): Promise<CanonicalJson | ApplicationFailure> {
    return this.#run(signal, async currentSignal => {
      const result = await this.#read({contractId: input.capabilityId, input: captureCanonicalJson(input.input)}, currentSignal);
      return result.ok ? result.value : result.failure;
    });
  }

  getResult(input: ImmutableReadInput, signal: AbortSignal): Promise<{readonly ok: true; readonly value: ImmutableReadTransport} | {readonly ok: false; readonly failure: ApplicationFailure}> {
    return this.#run(signal, async currentSignal => {
      const entry = immutableReadContractRegistry.requireIdentity(input.contractId, "1");
      const command = entry.parseNormalizedInput(input.input);
      const permit = this.ports.work.reserveRead(new TextEncoder().encode(canonicalJsonStringify(command)).length);
      try {
        const result = await this.#read({contractId: entry.contractId, input: command}, currentSignal);
        if (!result.ok) return result;
        if (currentSignal.aborted || this.ports.signal.aborted) throw new RuntimeOperationError("request_aborted");
        if (admitMcpToolResultForDelivery(formatImmutableReadResult(entry.contractId, command, result.value)).status === "admitted") {
          return {ok: true, value: {kind: "inline", result: result.value}};
        }
        // There is no second domain read and no foreground result upload.
        const prepared = this.ports.snapshots.prepare({contractId: entry.contractId, contractVersion: entry.contractVersion,
          normalizedInput: command, admittedResult: result.value});
        if (prepared.status !== "available") throw new RuntimeOperationError(prepared.reason === "capacity_exceeded" ? "result_too_large" : "runtime_state_unavailable");
        const resource = boundedSnapshotResource(prepared.value, command);
        if (admitMcpToolResultForDelivery(createMcpSnapshotResult(resource)).status !== "admitted") throw new RuntimeOperationError("result_too_large");
        const committed = this.ports.snapshots.commit({contractId: entry.contractId, contractVersion: entry.contractVersion,
          normalizedInput: command, admittedResult: result.value});
        if (committed.status !== "available") throw new RuntimeOperationError(committed.reason === "capacity_exceeded" ? "result_too_large" : "runtime_state_unavailable");
        if (committed.value.snapshotId !== prepared.value.snapshotId) throw new RuntimeOperationError("runtime_state_unavailable");
        return {ok: true, value: {kind: "reference", resource}};
      } finally {permit.release();}
    });
  }

  async #read(input: ImmutableReadInput, signal: AbortSignal): Promise<ReadResult> {
    const entry = immutableReadContractRegistry.requireIdentity(input.contractId, "1");
    const command = entry.parseNormalizedInput(input.input);
    let value: unknown;
    if (entry.contract === accountAssetApplicationContracts.collection) {
      try {value = await this.ports.accountAssets.list(accountAssetCollectionRequestBody(accountAssetApplicationContracts.collection.applicationContract.parseNormalizedInput(command)), signal);}
      catch (error) {return {ok: false, failure: entry.parseFailure(normalizeAccountAssetError(error).failure)};}
    } else if (entry.contract === tokenCatalogApplicationContracts.selection || entry.contract === tokenCatalogApplicationContracts.selections) {
      try {value = entry.contract === tokenCatalogApplicationContracts.selection
        ? await this.ports.token.getSelection(tokenCatalogApplicationContracts.selection.applicationContract.parseNormalizedInput(command), signal)
        : await this.ports.token.listSelections(tokenSelectionListRequestBody(tokenCatalogApplicationContracts.selections.applicationContract.parseNormalizedInput(command)), signal);}
      catch (error) {return {ok: false, failure: entry.parseFailure(normalizeTokenCatalogError(error).failure)};}
    } else if (entry.contract === receiptApplicationContracts.get || entry.contract === receiptApplicationContracts.list) {
      try {value = entry.contract === receiptApplicationContracts.get ? this.ports.activity.get(receiptApplicationContracts.get.parseInput(command))
        : this.ports.activity.list(receiptApplicationContracts.list.parseInput(command));}
      catch (error) {return {ok: false, failure: entry.parseFailure(normalizeReceiptActivityFailure(error, signal))};}
    } else {
      const definition = interfaceReadCapabilityRegistry.get(entry.contractId);
      if (definition === undefined || definition !== entry.contract) throw new TypeError("Immutable source has no canonical execution owner.");
      const result = await this.ports.bindings.invoke(definition, command, {signal});
      if (!result.ok) return {ok: false, failure: entry.parseFailure(result)};
      value = result;
    }
    if (typeof value === "object" && value !== null && "ok" in value && value.ok === false) {
      return {ok: false, failure: entry.parseFailure(value)};
    }
    return {ok: true, value: entry.parseResult(command, value)};
  }

  #run<Value>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
    if (!this.#lifecycle.admission.isOpen || this.ports.signal.aborted) return Promise.reject(new RuntimeOperationError("runtime_state_unavailable"));
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, {once: true}); if (signal.aborted) abort();
    this.#controllers.add(controller);
    const call = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new RuntimeOperationError("request_aborted");
      return operation(controller.signal);
    }).finally(() => {this.#controllers.delete(controller); this.#calls.delete(call); signal.removeEventListener("abort", abort);});
    this.#calls.add(call); return call;
  }
  close(): Promise<void> {return this.#lifecycle.close();}
}

export const extendImmutableReadRoutes = (routes: RuntimeRouteRegistry, application: ImmutableReadApplication): RuntimeRouteRegistry => routes.extend([
  {method: "POST", mutation: "declared_control", pathPattern: immutableReadResultIdentity.path,
    maximumResponseBytes: publicReadResponseLimitBytes, successStatus: 200,
    handler: async context => {
      const admitted = admitApplicationInput(immutableReadResultContract, context.body);
      if (!admitted.ok) return {ok: false, failure: admitted.failure};
      try {
        const result = await application.getResult(admitted.value, context.signal);
        return result.ok ? {ok: true, body: captureCanonicalJson(immutableReadResultContract.parsePublicSuccess(admitted.value, result.value))} : result;
      } catch (error) {return {ok: false, failure: getRuntimeOperationFailure(error) ??
        createApplicationFailure(immutableReadResultContract.errorRegistry, context.signal.aborted ? "request_aborted" : "internal_error")};}
    }},
], immutableReadInterfaceErrorMappings);
