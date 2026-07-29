import { describe, expect, it } from "vitest";

import {
  createWalletObservationStore,
  createWalletObservationState,
  observeExactWalletOperation,
  observeExpiredWalletOperation,
  observeWalletCurrent,
  trackWalletOperationResult,
} from "../../../src/interfaces/web/wallet-observation.js";
import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationPresentation,
} from "../../../src/wallet/operation-contract.js";

const operationA = "A".repeat(43);
const operationB = "E".repeat(43);
const expiresAt = "2099-12-31T23:59:59.000Z";
const disconnected = Object.freeze({ status: "disconnected" as const, reason: "no_session" as const });

const operation = (
  operationId: string,
  state: "awaiting_wallet_approval" | "cancelled",
) => parseWalletManagementOperation({
  operationId,
  kind: "connect",
  state,
  connectionRevision: "1",
  expiresAt,
  result: null,
  failure: null,
});

const presentation = (
  operationId: string,
  state: "awaiting_wallet_approval" | "cancelled",
) => parseWalletOperationPresentation({
  operation: operation(operationId, state),
  access: "interactive",
});

const absent = () => parseWalletCurrentOperationProjection({
  status: "absent",
  connectionRevision: "1",
  connection: disconnected,
});

const present = (operationId: string) => parseWalletCurrentOperationProjection({
  status: "present",
  connectionRevision: "1",
  connection: disconnected,
  presentation: presentation(operationId, "awaiting_wallet_approval"),
});

const memoryStorage = () => {
  const values = new Map<string, string>();
  return Object.freeze({
    values,
    storage: Object.freeze({
      read: (): string | null => values.get("littlejohn.wallet-operation-observation") ?? null,
      write: (value: string | undefined): void => {
        if (value === undefined) values.delete("littlejohn.wallet-operation-observation");
        else values.set("littlejohn.wallet-operation-observation", value);
      },
    }),
  });
};

describe("wallet browser observation", () => {
  it("retains one exact observation cursor across credential reload and clears it after terminal", () => {
    const memory = memoryStorage();
    const firstStore = createWalletObservationStore(memory.storage);
    const first = observeWalletCurrent(firstStore.load(), present(operationA));
    if (first.kind !== "accepted") throw new Error("Expected the first current observation.");
    firstStore.save(first.state);
    expect([...memory.values.entries()]).toEqual([
      [
        "littlejohn.wallet-operation-observation",
        JSON.stringify({ trackedOperationId: operationA }),
      ],
    ]);

    const afterReload = createWalletObservationStore(memory.storage).load();
    const pendingExact = observeWalletCurrent(afterReload, absent());
    expect(pendingExact).toMatchObject({ kind: "read_exact", operationId: operationA });
    if (pendingExact.kind !== "read_exact") throw new Error("Expected the retained operation read.");

    const completed = observeExactWalletOperation(
      pendingExact,
      presentation(operationA, "cancelled"),
    );
    if (completed.kind !== "accepted") throw new Error("Expected the terminal observation.");
    const finalStore = createWalletObservationStore(memory.storage);
    finalStore.save(completed.state);

    expect(completed.terminal).toMatchObject({ operationId: operationA, state: "cancelled" });
    expect(finalStore.load()).toEqual({
      notifiedTerminalOperationId: operationA,
    });
    expect(memory.values.get("littlejohn.wallet-operation-observation"))
      .toBe(JSON.stringify({ notifiedTerminalOperationId: operationA }));

    const repeated = observeWalletCurrent(finalStore.load(), absent());
    expect(repeated).toEqual({
      kind: "accepted",
      state: { notifiedTerminalOperationId: operationA },
      wallet: absent(),
    });
  });

  it("treats malformed or unavailable tab storage as empty UI state", () => {
    const malformed = {
      read: (): string => "not-an-operation-id",
      write: (): void => undefined,
    };
    const unavailable = {
      read: (): string => { throw new Error("unavailable"); },
      write: (): void => { throw new Error("unavailable"); },
    };

    expect(() => createWalletObservationState("not-an-operation-id")).toThrow();
    expect(createWalletObservationStore(malformed).load()).toEqual({});
    const store = createWalletObservationStore(unavailable);
    expect(store.load()).toEqual({});
    expect(() => { store.save({ trackedOperationId: operationA }); }).not.toThrow();

    const memory = memoryStorage();
    memory.values.set(
      "littlejohn.wallet-operation-observation",
      JSON.stringify({ trackedOperationId: operationA }),
    );
    createWalletObservationStore(memory.storage).save({ trackedOperationId: "not-an-operation-id" });
    expect(memory.values.size).toBe(0);
  });

  it("persists an immediate terminal response until the next observation publishes it", () => {
    const memory = memoryStorage();
    const store = createWalletObservationStore(memory.storage);
    const terminal = operation(operationA, "cancelled");
    const pending = trackWalletOperationResult(createWalletObservationState(), terminal);
    store.save(pending);

    expect(createWalletObservationStore(memory.storage).load()).toEqual({
      trackedOperationId: operationA,
    });
    expect(observeWalletCurrent(pending, absent())).toMatchObject({
      kind: "accepted",
      terminal,
    });
  });

  it("follows one exact operation through terminal before adopting its successor", () => {
    const first = observeWalletCurrent(createWalletObservationState(), present(operationA));
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") throw new Error("Expected the first current observation.");

    const successor = present(operationB);
    const pendingExact = observeWalletCurrent(first.state, successor);
    expect(pendingExact).toMatchObject({ kind: "read_exact", operationId: operationA });
    if (pendingExact.kind !== "read_exact") throw new Error("Expected the retained operation read.");

    const completed = observeExactWalletOperation(
      pendingExact,
      presentation(operationA, "cancelled"),
    );
    expect(completed).toMatchObject({
      kind: "accepted",
      wallet: successor,
      terminal: { operationId: operationA, state: "cancelled" },
      state: { trackedOperationId: operationB, notifiedTerminalOperationId: operationA },
    });
  });

  it("accepts current state without inventing a terminal after retention expiry", () => {
    const first = observeWalletCurrent(createWalletObservationState(), present(operationA));
    if (first.kind !== "accepted") throw new Error("Expected the first current observation.");
    const candidate = absent();
    const pendingExact = observeWalletCurrent(first.state, candidate);
    if (pendingExact.kind !== "read_exact") throw new Error("Expected the retained operation read.");

    expect(observeExpiredWalletOperation(pendingExact)).toEqual({
      kind: "accepted",
      state: {},
      wallet: candidate,
    });
  });

  it("preserves an immediate terminal result while adopting a successor", () => {
    const terminal = operation(operationA, "cancelled");
    const tracked = trackWalletOperationResult(createWalletObservationState(), terminal);
    const successor = present(operationB);

    const observed = observeWalletCurrent(tracked, successor);
    expect(observed).toMatchObject({
      kind: "accepted",
      wallet: successor,
      terminal,
      state: { trackedOperationId: operationB, notifiedTerminalOperationId: operationA },
    });
    if (observed.kind !== "accepted") throw new Error("Expected the successor observation.");

    expect(observeWalletCurrent(observed.state, successor)).not.toHaveProperty("terminal");
  });

  it("retries instead of accepting contradictory nonterminal exact and current resources", () => {
    const first = observeWalletCurrent(createWalletObservationState(), present(operationA));
    if (first.kind !== "accepted") throw new Error("Expected the first current observation.");
    const pendingExact = observeWalletCurrent(first.state, present(operationB));
    if (pendingExact.kind !== "read_exact") throw new Error("Expected the retained operation read.");

    expect(observeExactWalletOperation(
      pendingExact,
      presentation(operationA, "awaiting_wallet_approval"),
    )).toEqual({ kind: "retry" });
    expect(observeExactWalletOperation(
      pendingExact,
      presentation(operationB, "cancelled"),
    )).toEqual({ kind: "retry" });
  });
});
