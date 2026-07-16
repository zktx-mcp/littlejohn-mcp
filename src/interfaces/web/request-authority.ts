export interface WalletOperationRequest {
  readonly epoch: number;
  readonly kind: "poll" | "control";
  readonly signal?: AbortSignal;
}

export interface WalletOperationRequestAuthority {
  activate(): void;
  beginPoll(): WalletOperationRequest | undefined;
  beginControl(): WalletOperationRequest | undefined;
  isCurrent(request: WalletOperationRequest): boolean;
  cancelPoll(request: WalletOperationRequest): void;
  finishControl(request: WalletOperationRequest): void;
  close(): void;
}

export const createWalletOperationRequestAuthority = (): WalletOperationRequestAuthority => {
  let epoch = 0;
  let closed = false;
  let controlInFlight = false;
  let activePoll: {
    readonly request: WalletOperationRequest;
    readonly controller: AbortController;
  } | undefined;

  const isCurrent = (request: WalletOperationRequest): boolean =>
    !closed && request.epoch === epoch && request.signal?.aborted !== true;

  return Object.freeze({
    activate: (): void => {
      if (!closed) return;
      closed = false;
      epoch += 1;
    },
    beginPoll: (): WalletOperationRequest | undefined => {
      if (closed || controlInFlight) return undefined;
      activePoll?.controller.abort();
      const controller = new AbortController();
      const request = Object.freeze({
        epoch: ++epoch,
        kind: "poll" as const,
        signal: controller.signal,
      });
      activePoll = Object.freeze({ request, controller });
      return request;
    },
    beginControl: (): WalletOperationRequest | undefined => {
      if (closed || controlInFlight) return undefined;
      controlInFlight = true;
      activePoll?.controller.abort();
      activePoll = undefined;
      return Object.freeze({ epoch: ++epoch, kind: "control" as const });
    },
    isCurrent,
    cancelPoll: (request: WalletOperationRequest): void => {
      if (request.kind !== "poll" || activePoll?.request !== request) return;
      activePoll.controller.abort();
      activePoll = undefined;
      epoch += 1;
    },
    finishControl: (request: WalletOperationRequest): void => {
      if (request.kind !== "control" || !isCurrent(request)) return;
      controlInFlight = false;
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      controlInFlight = false;
      activePoll?.controller.abort();
      activePoll = undefined;
      epoch += 1;
    },
  });
};
