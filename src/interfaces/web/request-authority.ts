export interface BrowserRequest {
  readonly epoch: number;
  readonly kind: "poll" | "control";
  readonly signal?: AbortSignal;
}

export interface BrowserRequestAuthority {
  activate(): void;
  beginPoll(): BrowserRequest | undefined;
  beginControl(): BrowserRequest | undefined;
  isCurrent(request: BrowserRequest): boolean;
  cancelPoll(request: BrowserRequest): void;
  finishControl(request: BrowserRequest): void;
  close(): void;
}

export const createBrowserRequestAuthority = (): BrowserRequestAuthority => {
  let epoch = 0;
  let closed = false;
  let controlInFlight = false;
  let activePoll: {
    readonly request: BrowserRequest;
    readonly controller: AbortController;
  } | undefined;

  const isCurrent = (request: BrowserRequest): boolean =>
    !closed && request.epoch === epoch && request.signal?.aborted !== true;

  return Object.freeze({
    activate: (): void => {
      if (!closed) return;
      closed = false;
      epoch += 1;
    },
    beginPoll: (): BrowserRequest | undefined => {
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
    beginControl: (): BrowserRequest | undefined => {
      if (closed || controlInFlight) return undefined;
      controlInFlight = true;
      activePoll?.controller.abort();
      activePoll = undefined;
      return Object.freeze({ epoch: ++epoch, kind: "control" as const });
    },
    isCurrent,
    cancelPoll: (request: BrowserRequest): void => {
      if (request.kind !== "poll" || activePoll?.request !== request) return;
      activePoll.controller.abort();
      activePoll = undefined;
      epoch += 1;
    },
    finishControl: (request: BrowserRequest): void => {
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
