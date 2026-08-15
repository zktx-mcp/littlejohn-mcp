import {
  admitApplicationInput,
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
  problemJsonContentType,
  type RuntimeHttpRequest,
} from "../runtime/http-boundary.js";
import type {
  RuntimeOwnerSession,
  RuntimeOwnerSessionIdentity,
  RuntimeOwnerSessionPort,
} from "../runtime/owner-session.js";
import {
  getRuntimeOperationFailure,
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
} from "./local-operation.js";
import { resolveLocalOperationIdentity } from "./local-operation.js";

export type { LocalOperationIdentity } from "./local-operation.js";

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

interface OwnerSessionOwnership {
  readonly acquisition: Promise<void>;
  session: RuntimeOwnerSession | undefined;
  release: Promise<void> | undefined;
  releaseRejected: boolean;
}

interface AcquiredOwnerSession {
  readonly ownership: OwnerSessionOwnership;
  readonly session: RuntimeOwnerSession;
}

export class LocalOperationClient {
  readonly #ownerSessions: RuntimeOwnerSessionPort;
  readonly #lifecycle = new AbortController();
  readonly #active = new Set<Promise<void>>();
  readonly #sessions = new Set<OwnerSessionOwnership>();
  #state: "open" | "closing" | "closed" = "open";
  #closePromise: Promise<void> | undefined;

  constructor(input: Readonly<{
    ownerSessions: RuntimeOwnerSessionPort;
  }>) {
    this.#ownerSessions = input.ownerSessions;
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
    let start!: () => void;
    const execution = new Promise<LocalOperationResult<Success>>((resolve, reject) => {
      start = () => { void this.#invoke(binding, inputValue, callerSignal).then(resolve, reject); };
    });
    let settlement!: Promise<void>;
    settlement = execution.then(() => undefined, () => undefined).finally(() => this.#active.delete(settlement));
    this.#active.add(settlement);
    start();
    return execution;
  }

  async #invoke<Input, Success>(
    binding: LocalOperationBinding<Input, Success>,
    inputValue: unknown,
    callerSignal?: AbortSignal,
  ): Promise<LocalOperationResult<Success>> {
    const admission = admitApplicationInput(binding.contract, inputValue);
    if (!admission.ok) return admission;
    const input = admission.value;
    let operationId: OperationId | undefined;
    try {
      const selected = binding.operationId(input);
      operationId = selected === undefined ? undefined : operationIdSchema.parse(selected);
      if (binding.action !== "read" && operationId === undefined) {
        throw new TypeError("Operation ID is required.");
      }
    }
    catch {
      return { ok: false, failure: createApplicationFailure(binding.contract.errorRegistry, "invalid_input") };
    }
    let acquired: AcquiredOwnerSession;
    try { acquired = await this.#openSession(); }
    catch (error) { return this.#requestFailure(binding, error); }
    const { session } = acquired;
    try {
      const sent = await session.send({
        ...binding.actionRequest(input, operationId),
        maximumResponseBytes: internalResponseLimitBytes,
        responseDeadlineMilliseconds: responseObservationMilliseconds,
      }, callerSignal === undefined
        ? this.#lifecycle.signal
        : AbortSignal.any([callerSignal, this.#lifecycle.signal]));
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
      return await this.#recover(binding, input, operationId as OperationId, acquired);
    } finally {
      await this.#releaseAfterInvocation(acquired.ownership);
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
    const expectedContentType = response.statusCode >= 400
      ? problemJsonContentType
      : jsonContentType;
    if (response.contentType !== expectedContentType || response.cacheControl !== noStoreCacheControl) {
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
    original: AcquiredOwnerSession,
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
      targetOperationId = operationIdSchema.parse(targetBinding.operationId(targetInput));
      if (targetOperationId !== operationId) {
        throw new TypeError("Recovery target selected another operation.");
      }
      targetRequest = targetBinding.actionRequest(targetInput, targetOperationId);
    } catch {
      return createDeliveryUnknown(binding.action as OperationDeliveryAction, operationId);
    }
    const identity = original.session.identity;
    let acquired = original;
    let replacement = false;
    if (!acquired.session.usable) {
      try {
        acquired = await this.#openSession();
        replacement = true;
      }
      catch { return createDeliveryUnknown(binding.action as OperationDeliveryAction, operationId); }
      if (!sameOwner(identity, acquired.session.identity)) {
        await this.#releaseAfterInvocation(acquired.ownership);
        return createDeliveryUnknown(binding.action as OperationDeliveryAction, operationId);
      }
    }
    try {
      const read = await acquired.session.send({
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
      if (replacement) await this.#releaseAfterInvocation(acquired.ownership);
    }
  }

  async #openSession(): Promise<AcquiredOwnerSession> {
    if (this.#state !== "open") throw new DOMException("Request aborted.", "AbortError");
    let resolveAcquisition!: () => void;
    let rejectAcquisition!: (reason?: unknown) => void;
    const acquisition = new Promise<void>((resolve, reject) => {
      resolveAcquisition = resolve;
      rejectAcquisition = reject;
    });
    const ownership: OwnerSessionOwnership = {
      acquisition,
      session: undefined,
      release: undefined,
      releaseRejected: false,
    };
    this.#sessions.add(ownership);
    try {
      const opening = this.#ownerSessions.openOwnerSession(this.#lifecycle.signal);
      void Promise.resolve(opening).then(
        (session) => {
          ownership.session = session;
          resolveAcquisition();
        },
        rejectAcquisition,
      );
    } catch (error) {
      rejectAcquisition(error);
    }
    try {
      await acquisition;
    } catch (error) {
      this.#sessions.delete(ownership);
      throw error;
    }
    const session = ownership.session;
    if (session === undefined) throw new TypeError("Owner session acquisition did not publish a session.");
    if (this.#state !== "open") throw new DOMException("Request aborted.", "AbortError");
    return { ownership, session };
  }

  #releaseSession(ownership: OwnerSessionOwnership, retryRejected: boolean): Promise<void> {
    if (
      ownership.release !== undefined &&
      (!ownership.releaseRejected || !retryRejected)
    ) return ownership.release;
    const session = ownership.session;
    if (session === undefined) return Promise.reject(
      new TypeError("Owner session release started before acquisition settled."),
    );
    let run!: () => void;
    const effect = new Promise<void>((resolve, reject) => {
      run = () => {
        try {
          session.close();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
    });
    const release = effect.then(
      () => { this.#sessions.delete(ownership); },
      (reason: unknown) => {
        ownership.releaseRejected = true;
        throw reason;
      },
    );
    ownership.release = release;
    ownership.releaseRejected = false;
    run();
    return release;
  }

  async #releaseAfterInvocation(ownership: OwnerSessionOwnership): Promise<void> {
    try {
      await this.#releaseSession(ownership, false);
    } catch {
      this.#failClosed();
    }
  }

  #failClosed(): void {
    if (this.#state !== "open") return;
    this.#state = "closing";
    this.#lifecycle.abort();
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
    let start!: () => void;
    const closing = new Promise<void>((resolve, reject) => {
      start = () => { void this.#performClose().then(resolve, reject); };
    });
    this.#closePromise = closing;
    this.#state = "closing";
    void closing.then(
      () => undefined,
      () => {
        if (this.#state !== "closed" && this.#closePromise === closing) {
          this.#closePromise = undefined;
        }
      },
    );
    start();
    return closing;
  }

  async #performClose(): Promise<void> {
    this.#lifecycle.abort();
    await Promise.allSettled([...this.#sessions].map(({ acquisition }) => acquisition));
    const owned = [...this.#sessions].filter(
      (ownership): ownership is OwnerSessionOwnership & { session: RuntimeOwnerSession } =>
        ownership.session !== undefined,
    );
    const releases = await Promise.allSettled(
      owned.map((ownership) => this.#releaseSession(ownership, true)),
    );
    await Promise.allSettled([...this.#active]);
    const failures: unknown[] = [];
    for (const release of releases) {
      if (release.status === "rejected") failures.push(release.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Local operation session cleanup failed.");
    }
    if (this.#sessions.size !== 0 || this.#active.size !== 0) {
      throw new Error("Local operation client cleanup did not release all ownership.");
    }
    this.#state = "closed";
  }
}
