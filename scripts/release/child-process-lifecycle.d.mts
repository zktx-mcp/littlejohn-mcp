import type { ChildProcess } from "node:child_process";

export interface OwnedChildProcess {
  readonly child: ChildProcess;
  readonly failure: Promise<never>;
  readonly termination: Promise<void>;
  isTerminated(): boolean;
  terminate(): Promise<void>;
  write(input: string | Uint8Array): Promise<void>;
}

export function waitForPromise<Result>(
  promise: PromiseLike<Result>,
  timeoutMilliseconds: number,
  label: string,
): Promise<Result>;

export function ownChildProcess(
  child: ChildProcess,
  label: string,
  shutdownTimeoutMilliseconds: number,
): OwnedChildProcess;

export function initializeOwnedChild<Result>(
  ownership: OwnedChildProcess,
  initialize: () => Result | PromiseLike<Result>,
  timeoutMilliseconds: number,
  label: string,
): Promise<Result>;
