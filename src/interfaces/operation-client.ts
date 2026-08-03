import {
  captureCanonicalJson,
  createApplicationFailure,
  operationIdSchema,
  type ApplicationFailure,
  type CanonicalJson,
  type OperationId,
} from "../core/index.js";
import {
  internalResponseLimitBytes,
  jsonContentType,
  noStoreCacheControl,
  type RuntimeHttpRequest,
} from "../runtime/http-boundary.js";
import type {
  RuntimeOwnerSession,
  RuntimeOwnerSessionIdentity,
  RuntimeOwnerSessionPort,
} from "../runtime/owner-session.js";
import {
  getRuntimeOperationFailure,
  type InterfaceErrorMappingRegistry,
} from "../runtime/errors.js";
import {
  createDeliveryUnknown,
  type DeliveryUnknown,
  type OperationDeliveryAction,
} from "./operation-delivery.js";
import { parseProblemDetailsFailure } from "./http-client.js";
import type {
  LocalOperationBinding,
  LocalOperationIdentity,
} from "./identities.js";
import { resolveLocalOperationIdentity } from "./identities.js";

export type { LocalOperationIdentity } from "./identities.js";

const responseObservationMilliseconds = 5 * 60 * 1_000;
const recoveryReadMilliseconds = 2_000;

export type LocalOperationResult<Success> =
  | Readonly<{ ok: true; value: Success }>
  | Readonly<{ ok: false; failure: ApplicationFailure }>
  | DeliveryUnknown;

const sameOwner = (
  left: RuntimeOwnerSessionIdentity,
  right: RuntimeOwnerSessionIdentity,
): boolean => left.profileId === right.profileId &&
  left.ownerInstanceId === right.ownerInstanceId &&
  left.configurationMac === right.configurationMac &&
  left.ownerRevision === right.ownerRevision;

const parseJsonBytes = (bytes: Uint8Array): CanonicalJson =>
  captureCanonicalJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);

export class LocalOperationClient {
  readonly #ownerSessions: RuntimeOwnerSessionPort;
  readonly #createOperationId: () => OperationId;
  readonly #lifecycle = new AbortController();
  readonly #active = new Set<Promise<void>>();
  readonly #sessions = new Set<RuntimeOwnerSession>();
  #state: "open" | "closing" | "closed" = "open";
  #closePromise: Promise<void> | undefined;

  constructor(input: Readonly<{
    ownerSessions: RuntimeOwnerSessionPort;
    createOperationId: () => OperationId;
  }>) {
    this.#ownerSessions = input.ownerSessions;
    this.#createOperationId = input.createOperationId;
  }

  invoke<Input, Success>(
    identity: LocalOperationIdentity<Input, Success>,
    inputValue: unknown,
    callerSignal?: AbortSignal,
  ): Promise<LocalOperationResult<Success>> {
    const binding = resolveLocalOperationIdentity(identity);
    if (this.#state !== "open") {
      return Promise.resolve({
        ok: false,
        failure: createApplicationFailure(binding.contract.errorRegistry, "runtime_state_unavailable"),
      });
    }
    const execution = this.#invoke(binding, inputValue, callerSignal);
    let settlement!: Promise<void>;
    settlement = execution.then(() => undefined, () => undefined).finally(() => this.#active.delete(settlement));
    this.#active.add(settlement);
    return execution;
  }

  async #invoke<Input, Success>(
    binding: LocalOperationBinding<Input, Success>,
    inputValue: unknown,
    callerSignal?: AbortSignal,
  ): Promise<LocalOperationResult<Success>> {
    let input: Input;
    try { input = binding.contract.parseInput(inputValue); }
    catch {
      return { ok: false, failure: createApplicationFailure(binding.contract.errorRegistry, "invalid_input") };
    }
    const allocated = binding.action === "start" ? this.#createOperationId() : undefined;
    let operationId: OperationId | undefined;
    try {
      const selected = binding.operationId(input, allocated);
      operationId = selected === undefined ? undefined : operationIdSchema.parse(selected);
      if (binding.action !== "read" && operationId === undefined) throw new TypeError("Operation ID is required.");
    }
    catch {
      return { ok: false, failure: createApplicationFailure(binding.contract.errorRegistry, "invalid_input") };
    }
    let session: RuntimeOwnerSession;
    try { session = await this.#openSession(); }
    catch (error) { return this.#requestFailure(binding, error); }
    try {
      const sent = await session.send({
        ...binding.actionRequest(input, operationId),
        maximumResponseBytes: internalResponseLimitBytes,
        responseDeadlineMilliseconds: responseObservationMilliseconds,
      }, callerSignal);
      if (sent.status === "request_not_sent") {
        return this.#requestFailure(binding, sent.reason === "request_aborted"
          ? new DOMException("Request aborted.", "AbortError")
          : undefined);
      }
      if (sent.status === "response_received") {
        try {
          return this.#parseReceived(binding, input, operationId, sent.response);
        } catch {
          if (binding.action === "read") {
            return { ok: false, failure: createApplicationFailure(binding.contract.errorRegistry, "internal_error") };
          }
        }
      }
      if (binding.action === "read") {
        return { ok: false, failure: createApplicationFailure(binding.contract.errorRegistry, "runtime_state_unavailable") };
      }
      return await this.#recover(binding, input, operationId as OperationId, session);
    } finally {
      this.#releaseSession(session);
    }
  }

  #parseReceived<Input, Success>(
    binding: LocalOperationBinding<Input, Success>,
    input: Input,
    operationId: OperationId | undefined,
    response: Readonly<{
      statusCode: number;
      contentType: string | undefined;
      cacheControl: string | undefined;
      bytes: Uint8Array;
    }>,
  ): LocalOperationResult<Success> {
    if (response.contentType !== jsonContentType || response.cacheControl !== noStoreCacheControl) {
      throw new TypeError("Owner response provenance is invalid.");
    }
    const body = parseJsonBytes(response.bytes);
    if (response.statusCode >= 400) {
      const failure = parseProblemDetailsFailure(
        { status: response.statusCode, body },
        binding.contract.errorRegistry,
        binding.errorMappings,
      );
      return { ok: false, failure: binding.contract.normalizeFailure(failure) };
    }
    if (response.statusCode !== 200) throw new TypeError("Owner response status is invalid.");
    return { ok: true, value: binding.parseActionResponse(input, operationId, body) };
  }

  async #recover<Input, Success>(
    binding: LocalOperationBinding<Input, Success>,
    input: Input,
    operationId: OperationId,
    originalSession: RuntimeOwnerSession,
  ): Promise<LocalOperationResult<Success>> {
    const observation = binding.recoveryObservation;
    if (observation === undefined) {
      return createDeliveryUnknown(binding.action as OperationDeliveryAction, operationId);
    }
    let targetBinding: LocalOperationBinding<Readonly<{ operationId: OperationId }>, unknown>;
    let targetInput: Readonly<{ operationId: OperationId }>;
    let targetOperationId: OperationId;
    let targetRequest: RuntimeHttpRequest;
    try {
      targetBinding = resolveLocalOperationIdentity(observation.target);
      if (targetBinding.action !== "read" || targetBinding.recoveryObservation !== undefined) {
        throw new TypeError("Recovery target must be a terminal read.");
      }
      targetInput = targetBinding.contract.parseInput({ operationId });
      targetOperationId = operationIdSchema.parse(targetBinding.operationId(targetInput, undefined));
      if (targetOperationId !== operationId) {
        throw new TypeError("Recovery target selected another operation.");
      }
      targetRequest = targetBinding.actionRequest(targetInput, targetOperationId);
    } catch {
      return createDeliveryUnknown(binding.action as OperationDeliveryAction, operationId);
    }
    const identity = originalSession.identity;
    let session = originalSession;
    let replacement = false;
    if (!session.usable) {
      try {
        session = await this.#openSession();
        replacement = true;
      }
      catch { return createDeliveryUnknown(binding.action as OperationDeliveryAction, operationId); }
      if (!sameOwner(identity, session.identity)) {
        this.#releaseSession(session);
        return createDeliveryUnknown(binding.action as OperationDeliveryAction, operationId);
      }
    }
    try {
      const read = await session.send({
        ...targetRequest,
        maximumResponseBytes: internalResponseLimitBytes,
        responseDeadlineMilliseconds: recoveryReadMilliseconds,
      }, this.#lifecycle.signal);
      if (read.status !== "response_received") {
        return createDeliveryUnknown(binding.action as OperationDeliveryAction, operationId);
      }
      try {
        if (
          read.response.statusCode !== 200 ||
          read.response.contentType !== jsonContentType ||
          read.response.cacheControl !== noStoreCacheControl
        ) throw new TypeError("Recovery response provenance is invalid.");
        const body = parseJsonBytes(read.response.bytes);
        const observed = targetBinding.parseActionResponse(targetInput, targetOperationId, body);
        return { ok: true, value: observation.admitObservedResult(input, operationId, observed) };
      } catch {
        return createDeliveryUnknown(binding.action as OperationDeliveryAction, operationId);
      }
    } finally {
      if (replacement) this.#releaseSession(session);
    }
  }

  async #openSession(): Promise<RuntimeOwnerSession> {
    const opened = await this.#ownerSessions.openOwnerSession(this.#lifecycle.signal);
    if (this.#state !== "open") {
      opened.close();
      throw new DOMException("Request aborted.", "AbortError");
    }
    this.#sessions.add(opened);
    return opened;
  }

  #releaseSession(session: RuntimeOwnerSession): void {
    session.close();
    this.#sessions.delete(session);
  }

  #requestFailure<Input, Success>(
    binding: LocalOperationBinding<Input, Success>,
    error: unknown,
  ): Readonly<{ ok: false; failure: ApplicationFailure }> {
    const runtimeFailure = getRuntimeOperationFailure(error);
    const code = error instanceof DOMException && error.name === "AbortError"
      ? "request_aborted"
      : runtimeFailure?.error.code ?? "runtime_state_unavailable";
    try {
      return {
        ok: false,
        failure: binding.contract.normalizeFailure(
          createApplicationFailure(binding.contract.errorRegistry, code),
        ),
      };
    } catch {
      return {
        ok: false,
        failure: createApplicationFailure(binding.contract.errorRegistry, "internal_error"),
      };
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = "closing";
    this.#lifecycle.abort();
    for (const session of this.#sessions) session.close();
    this.#sessions.clear();
    const closing = Promise.allSettled([...this.#active]).then(() => {
      this.#state = "closed";
    });
    this.#closePromise = closing;
    return closing;
  }
}
