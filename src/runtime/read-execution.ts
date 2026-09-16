import { createApplicationFailure, type ApplicationErrorRegistry, type ApplicationFailure, type CapabilityExecutionOwnerPort } from "../core/index.js";
import type { ApplicationAdmission } from "./application-lifecycle.js";

export class CapabilityReadExecutionOwner implements CapabilityExecutionOwnerPort {
  readonly #admission: ApplicationAdmission;
  readonly #owner = new AbortController();
  readonly #signal: AbortSignal;
  readonly #errors: ApplicationErrorRegistry;
  readonly #active = new Set<Promise<void>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(admission: ApplicationAdmission, errors: ApplicationErrorRegistry, ownerSignal?: AbortSignal) {
    this.#admission = admission;
    this.#errors = errors;
    this.#signal = ownerSignal === undefined ? this.#owner.signal : AbortSignal.any([this.#owner.signal, ownerSignal]);
  }

  #failure(code: string): ApplicationFailure { return createApplicationFailure(this.#errors, code); }

  execute<Result extends ApplicationFailure | Readonly<{ readonly ok: true }>>(
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (this.#closed || this.#signal.aborted || !this.#admission.isOpen) {
      return Promise.resolve(this.#failure(
        "runtime_state_unavailable",
      ) as Result);
    }
    let resolveResult!: (value: Result | PromiseLike<Result>) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<Result>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let settlement!: Promise<void>;
    settlement = result.then(() => undefined, () => undefined)
      .finally(() => this.#active.delete(settlement));
    this.#active.add(settlement);
    void this.#run(callerSignal, operation).then(resolveResult, rejectResult);
    return result;
  }

  async #run<Result extends ApplicationFailure | Readonly<{ readonly ok: true }>>(
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (callerSignal.aborted) {
      return this.#failure("request_aborted") as Result;
    }
    if (this.#signal.aborted) {
      return this.#failure("runtime_state_unavailable") as Result;
    }
    const signal = AbortSignal.any([callerSignal, this.#signal]);
    let result: Result;
    try {
      result = await operation(signal);
    } catch {
      if (callerSignal.aborted) {
        return this.#failure("request_aborted") as Result;
      }
      if (this.#signal.aborted) {
        return this.#failure("runtime_state_unavailable") as Result;
      }
      return this.#failure("internal_error") as Result;
    }
    if (callerSignal.aborted) {
      return this.#failure("request_aborted") as Result;
    }
    if (this.#signal.aborted) {
      return this.#failure("runtime_state_unavailable") as Result;
    }
    return result;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const active = [...this.#active];
    let resolveClose!: () => void;
    const close = new Promise<void>((resolve) => { resolveClose = resolve; });
    this.#closePromise = close;
    this.#owner.abort();
    void Promise.allSettled(active).then(() => resolveClose());
    return close;
  }
}
