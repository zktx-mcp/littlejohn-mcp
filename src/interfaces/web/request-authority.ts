export interface BrowserReadRequest {
  readonly epoch: number;
  readonly kind: "read";
  readonly signal: AbortSignal;
}

export interface BrowserControlRequest {
  readonly epoch: number;
  readonly kind: "control";
  readonly signal?: undefined;
}

export type BrowserRequest = BrowserReadRequest | BrowserControlRequest;

export interface BrowserRequestAuthority {
  activate(): void;
  beginRead(): BrowserReadRequest | undefined;
  beginControl(): BrowserControlRequest | undefined;
  isCurrent(request: BrowserRequest): boolean;
  cancelRead(request: BrowserReadRequest): void;
  invalidateRead(): void;
  finishControl(request: BrowserControlRequest): void;
  close(): void;
}

export const createBrowserRequestAuthority = (): BrowserRequestAuthority => {
  let epoch = 0;
  let closed = false;
  let controlInFlight = false;
  let activeRead: {
    readonly request: BrowserReadRequest;
    readonly controller: AbortController;
  } | undefined;

  const invalidateRead = (): void => {
    if (activeRead === undefined) return;
    activeRead.controller.abort();
    activeRead = undefined;
    epoch += 1;
  };

  const isCurrent = (request: BrowserRequest): boolean =>
    !closed && request.epoch === epoch && request.signal?.aborted !== true;

  return Object.freeze({
    activate: (): void => {
      if (!closed) return;
      closed = false;
      epoch += 1;
    },
    beginRead: (): BrowserReadRequest | undefined => {
      if (closed || controlInFlight) return undefined;
      invalidateRead();
      const controller = new AbortController();
      const request = Object.freeze({
        epoch: ++epoch,
        kind: "read" as const,
        signal: controller.signal,
      });
      activeRead = Object.freeze({ request, controller });
      return request;
    },
    beginControl: (): BrowserControlRequest | undefined => {
      if (closed || controlInFlight) return undefined;
      controlInFlight = true;
      invalidateRead();
      return Object.freeze({ epoch: ++epoch, kind: "control" as const });
    },
    isCurrent,
    cancelRead: (request: BrowserReadRequest): void => {
      if (activeRead?.request !== request) return;
      invalidateRead();
    },
    invalidateRead,
    finishControl: (request: BrowserControlRequest): void => {
      if (!isCurrent(request)) return;
      controlInFlight = false;
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      controlInFlight = false;
      invalidateRead();
      epoch += 1;
    },
  });
};
