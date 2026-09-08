import {
  createResourceOwnershipScope,
  type OwnedResourceRegistry,
} from "./resource-ownership.js";

export interface ApplicationAdmission {
  readonly isOpen: boolean;
}

export interface ApplicationLifecycle {
  readonly resources: OwnedResourceRegistry;
  readonly admission: ApplicationAdmission;
  open(): void;
  close(): Promise<void>;
}

export const createApplicationLifecycle = (): ApplicationLifecycle => {
  const scope = createResourceOwnershipScope();
  let state: "starting" | "open" | "closing" | "closed" = "starting";
  let activeClose: Promise<void> | undefined;

  return Object.freeze({
    resources: scope.resources,
    admission: Object.freeze({ get isOpen(): boolean { return state === "open"; } }),
    open(): void {
      if (state !== "starting") throw new TypeError("Application lifecycle cannot open.");
      scope.seal();
      state = "open";
    },
    close(): Promise<void> {
      if (state === "closed") return Promise.resolve();
      if (activeClose !== undefined) return activeClose;
      scope.seal();
      state = "closing";
      let tracked!: Promise<void>;
      tracked = Promise.resolve().then(() => scope.close()).then(() => {
        state = "closed";
      }).finally(() => {
        if (activeClose === tracked) activeClose = undefined;
      });
      activeClose = tracked;
      return tracked;
    },
  });
};
