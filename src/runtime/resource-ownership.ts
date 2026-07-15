export interface OwnedResource {
  close(): Promise<void> | void;
}

export interface OwnedResourceRegistration {
  replace(resource: OwnedResource): void;
  transfer(): void;
}

export interface OwnedResourceRegistry {
  register(resource: OwnedResource): OwnedResourceRegistration;
}

export interface ResourceOwnershipScope extends OwnedResource {
  readonly resources: OwnedResourceRegistry;
  readonly size: number;
  readonly empty: boolean;
  readonly sealed: boolean;
  seal(): void;
  close(): Promise<void>;
}

export const createResourceOwnershipScope = (): ResourceOwnershipScope => {
  interface CapturedResource {
    readonly resource: OwnedResource;
    readonly close: () => Promise<void> | void;
  }

  interface Entry {
    current: CapturedResource;
    active: boolean;
  }

  const capture = (resource: OwnedResource): CapturedResource => {
    if (
      resource === null ||
      (typeof resource !== "object" && typeof resource !== "function")
    ) throw new TypeError("Owned resource is invalid.");
    const close = resource.close;
    if (typeof close !== "function") throw new TypeError("Owned resource is invalid.");
    return Object.freeze({
      resource,
      close: () => Reflect.apply(close, resource, []) as Promise<void> | void,
    });
  };

  const entries: Entry[] = [];
  const identities = new Set<OwnedResource>();
  let sealed = false;
  let mutationActive = false;
  let activeClose: Promise<void> | undefined;

  const mutate = <Result>(operation: () => Result): Result => {
    if (mutationActive) throw new TypeError("Owned resource mutation is active.");
    mutationActive = true;
    try { return operation(); }
    finally { mutationActive = false; }
  };

  const resources: OwnedResourceRegistry = Object.freeze({
    register(resource: OwnedResource): OwnedResourceRegistration {
      return mutate(() => {
        if (sealed) throw new TypeError("Owned resource scope is sealed.");
        if (activeClose !== undefined) throw new TypeError("Owned resource cleanup is active.");
        if (identities.has(resource)) throw new TypeError("Owned resource is already registered.");
        const entry: Entry = { current: capture(resource), active: true };
        identities.add(resource);
        entries.push(entry);
        return Object.freeze({
          replace(replacement: OwnedResource): void {
            mutate(() => {
              if (!entry.active || sealed) {
                throw new TypeError("Owned resource registration is unavailable.");
              }
              if (identities.has(replacement)) {
                throw new TypeError("Owned resource is already registered.");
              }
              const next = capture(replacement);
              identities.delete(entry.current.resource);
              identities.add(replacement);
              entry.current = next;
            });
          },
          transfer(): void {
            mutate(() => {
              const index = entries.indexOf(entry);
              if (!entry.active || sealed || activeClose !== undefined || index < 0) {
                throw new TypeError("Owned resource registration is unavailable.");
              }
              entries.splice(index, 1);
              identities.delete(entry.current.resource);
              entry.active = false;
            });
          },
        });
      });
    },
  });

  const scope: ResourceOwnershipScope = {
    resources,
    get size(): number { return entries.length; },
    get empty(): boolean { return entries.length === 0; },
    get sealed(): boolean { return sealed; },
    seal(): void { mutate(() => { sealed = true; }); },
    close(): Promise<void> {
      if (mutationActive) throw new TypeError("Owned resource mutation is active.");
      if (activeClose !== undefined) return activeClose;
      let tracked!: Promise<void>;
      tracked = Promise.resolve().then(async () => {
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index];
          if (entry === undefined || !entry.active) continue;
          const current = entry.current;
          await current.close();
          if (entry.current !== current) break;
          const currentIndex = entries.indexOf(entry);
          if (currentIndex >= 0) entries.splice(currentIndex, 1);
          identities.delete(current.resource);
          entry.active = false;
        }
      }).finally(() => {
        if (activeClose === tracked) activeClose = undefined;
      });
      activeClose = tracked;
      return tracked;
    },
  };
  return Object.freeze(scope);
};
