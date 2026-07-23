import {
  captureCanonicalJson,
  createApplicationFailure,
  type ApplicationFailure,
  type CanonicalJson,
  type ReferenceWatchlistMutationInput,
  type ReferenceWatchlistReorderInput,
  type ReferenceWatchlistSuccess,
} from "../core/index.js";
import {
  referenceMarketInterfaceErrorMappings,
  type ReferenceMarketApplicationContract,
  type ReferenceMarketMutationCapabilityId,
} from "../market-portfolio/index.js";
import {
  internalResponseLimitBytes,
  jsonContentType,
  noStoreCacheControl,
} from "../runtime/http-boundary.js";
import { getRuntimeOperationFailure } from "../runtime/errors.js";
import type {
  RuntimeOwnerSession,
  RuntimeOwnerSessionPort,
} from "../runtime/owner-session.js";
import { parseProblemDetailsFailure } from "./http-client.js";
import {
  createReferenceMarketDeliveryUnknown,
  type ReferenceMarketDeliveryAction,
  type ReferenceMarketDeliveryUnknown,
} from "./reference-market-delivery.js";
import { referenceMarketInterfaceBindings } from "./identities.js";

const responseObservationMilliseconds = 5 * 60 * 1_000;

export type ReferenceMarketLocalMutationResult =
  | Readonly<{ ok: true; value: ReferenceWatchlistSuccess }>
  | Readonly<{ ok: false; failure: ApplicationFailure }>
  | ReferenceMarketDeliveryUnknown;

interface MutationDefinition<Input, CapabilityId extends ReferenceMarketMutationCapabilityId> {
  readonly action: ReferenceMarketDeliveryAction;
  readonly http: Readonly<{ method: "POST"; path: string }>;
  readonly contract: ReferenceMarketApplicationContract<Input, ReferenceWatchlistSuccess, CapabilityId>;
}

const parseJsonBytes = (bytes: Uint8Array): CanonicalJson =>
  captureCanonicalJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);

export class LocalMutationClient {
  readonly #ownerSessions: RuntimeOwnerSessionPort;
  readonly #lifecycle = new AbortController();
  readonly #active = new Set<Promise<void>>();
  readonly #sessions = new Set<RuntimeOwnerSession>();
  #state: "open" | "closing" | "closed" = "open";
  #closePromise: Promise<void> | undefined;

  constructor(ownerSessions: RuntimeOwnerSessionPort) {
    this.#ownerSessions = ownerSessions;
  }

  add(input: ReferenceWatchlistMutationInput, signal?: AbortSignal): Promise<ReferenceMarketLocalMutationResult> {
    return this.#start(referenceMarketInterfaceBindings.add, input, signal);
  }

  remove(input: ReferenceWatchlistMutationInput, signal?: AbortSignal): Promise<ReferenceMarketLocalMutationResult> {
    return this.#start(referenceMarketInterfaceBindings.remove, input, signal);
  }

  reorder(input: ReferenceWatchlistReorderInput, signal?: AbortSignal): Promise<ReferenceMarketLocalMutationResult> {
    return this.#start(referenceMarketInterfaceBindings.reorder, input, signal);
  }

  #start<Input, CapabilityId extends ReferenceMarketMutationCapabilityId>(
    definition: MutationDefinition<Input, CapabilityId>,
    input: unknown,
    callerSignal?: AbortSignal,
  ): Promise<ReferenceMarketLocalMutationResult> {
    if (this.#state !== "open") {
      return Promise.resolve({
        ok: false,
        failure: createApplicationFailure(definition.contract.applicationContract.errorRegistry, "runtime_state_unavailable"),
      });
    }
    const execution = this.#invoke(definition, input, callerSignal);
    let settlement!: Promise<void>;
    settlement = execution.then(() => undefined, () => undefined).finally(() => this.#active.delete(settlement));
    this.#active.add(settlement);
    return execution;
  }

  async #invoke<Input, CapabilityId extends ReferenceMarketMutationCapabilityId>(
    definition: MutationDefinition<Input, CapabilityId>,
    inputValue: unknown,
    callerSignal?: AbortSignal,
  ): Promise<ReferenceMarketLocalMutationResult> {
    let request: Input;
    try { request = definition.contract.parseInput(inputValue); }
    catch {
      return {
        ok: false,
        failure: createApplicationFailure(definition.contract.applicationContract.errorRegistry, "invalid_input"),
      };
    }
    if (callerSignal?.aborted === true) {
      return {
        ok: false,
        failure: createApplicationFailure(definition.contract.applicationContract.errorRegistry, "request_aborted"),
      };
    }
    let session: RuntimeOwnerSession;
    try {
      session = await this.#ownerSessions.openOwnerSession(
        callerSignal === undefined ? this.#lifecycle.signal : AbortSignal.any([callerSignal, this.#lifecycle.signal]),
      );
    } catch (error) {
      return this.#requestFailure(definition, error);
    }
    this.#sessions.add(session);
    const body = captureCanonicalJson(request);
    const unknown = (): ReferenceMarketDeliveryUnknown => createReferenceMarketDeliveryUnknown({
      action: definition.action,
      request,
    });
    try {
      const sent = await session.send({
        method: "POST",
        path: definition.http.path,
        body,
        maximumResponseBytes: internalResponseLimitBytes,
        responseDeadlineMilliseconds: responseObservationMilliseconds,
      }, callerSignal);
      if (sent.status === "request_not_sent") {
        return this.#requestFailure(
          definition,
          sent.reason === "request_aborted" ? new DOMException("Request aborted.", "AbortError") : undefined,
        );
      }
      if (sent.status !== "response_received") return unknown();
      try {
        if (sent.response.contentType !== jsonContentType || sent.response.cacheControl !== noStoreCacheControl) {
          throw new TypeError("Owner response provenance is invalid.");
        }
        const response = parseJsonBytes(sent.response.bytes);
        if (sent.response.statusCode >= 400) {
          const failure = parseProblemDetailsFailure(
            { status: sent.response.statusCode, body: response },
            definition.contract.applicationContract.errorRegistry,
            referenceMarketInterfaceErrorMappings,
          );
          return { ok: false, failure: definition.contract.normalizeFailure(failure) };
        }
        if (sent.response.statusCode !== 200) throw new TypeError("Owner response status is invalid.");
        return { ok: true, value: definition.contract.parsePublicSuccess(request, response) };
      } catch {
        return unknown();
      }
    } finally {
      session.close();
      this.#sessions.delete(session);
    }
  }

  #requestFailure<Input, CapabilityId extends ReferenceMarketMutationCapabilityId>(
    definition: MutationDefinition<Input, CapabilityId>,
    error: unknown,
  ): Readonly<{ ok: false; failure: ApplicationFailure }> {
    const runtimeFailure = getRuntimeOperationFailure(error);
    const code = error instanceof DOMException && error.name === "AbortError"
      ? "request_aborted"
      : runtimeFailure?.error.code ?? "runtime_state_unavailable";
    try {
      return {
        ok: false,
        failure: definition.contract.normalizeFailure(
          createApplicationFailure(definition.contract.applicationContract.errorRegistry, code),
        ),
      };
    } catch {
      return {
        ok: false,
        failure: createApplicationFailure(definition.contract.applicationContract.errorRegistry, "internal_error"),
      };
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = "closing";
    this.#lifecycle.abort();
    for (const session of this.#sessions) session.close();
    this.#sessions.clear();
    this.#closePromise = Promise.allSettled([...this.#active]).then(() => {
      this.#state = "closed";
    });
    return this.#closePromise;
  }
}
