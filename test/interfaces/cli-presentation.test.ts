import {describe, expect, it, vi} from "vitest";
import {runSigningCliCommand} from "../../src/interfaces/cli-signing.js";
import {runExchangeCliCommand} from "../../src/interfaces/cli-exchange.js";
import {signingApplicationContracts} from "../../src/review/signing-application-contracts.js";
import {exchangeApplicationContracts} from "../../src/review/application-contracts.js";
import {signingBindings} from "../../src/interfaces/signing-bindings.js";
import {exchangeBindings} from "../../src/interfaces/exchange-bindings.js";
import type {LocalOperationClient} from "../../src/interfaces/operation-client.js";
import type {RuntimeDispatchPort} from "../../src/interfaces/http-client.js";

const operationId = Buffer.alloc(32, 13).toString("base64url");

describe("CLI request result vocabulary", () => {
  it.each([
    ["signing", "discarded", "Closed."], ["signing", "unavailable", "Unavailable"],
    ["exchange", "discarded", "Closed"], ["exchange", "unavailable", "Unavailable"],
  ] as const)("shows %s %s without claiming a wallet refusal or another action", async (domain, status, expected) => {
    const contract = domain === "signing" ? signingApplicationContracts.cancel : exchangeApplicationContracts.cancel;
    const binding = domain === "signing" ? signingBindings.cancel : exchangeBindings.cancel;
    const value = contract.parsePublicSuccess({operationId}, {operationId, status});
    // Substitute only the external operation client at its admitted result boundary.
    const invoke = vi.fn(async () => ({ok: true as const, value}));
    const client = {invoke} as unknown as LocalOperationClient;
    const runtime = {dispatchRuntimeRequest: async () => {throw new Error("No public read is part of closing a request.");}} as RuntimeDispatchPort;
    const output: string[] = [];
    const errors: string[] = [];
    const terminal = {inputIsTTY: false, outputIsTTY: false, interruptSignal: new AbortController().signal,
      writeOutput: (text: string) => {output.push(text);}, writeError: (text: string) => {errors.push(text);},
      readLine: async () => {throw new Error("No new decision is part of closing a request.");},
      writeSignature: async (): Promise<never> => {throw new Error("Closing a request cannot deliver a signature.");},
    };
    const result = domain === "signing"
      ? await runSigningCliCommand(client, {kind: "cancel_review", operationId}, terminal)
      : await runExchangeCliCommand(runtime, client, {kind: "cancel_review", operationId, json: false}, terminal);
    expect(result).toBe(0);
    expect(output.join("")).toBe(`${expected}\n`);
    expect(errors).toEqual([]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(binding.identity, {operationId}, terminal.interruptSignal);
    expect(output.join("")).not.toMatch(/Declined|Cancelled|signature value/);
    expect(value).toEqual({operationId, status});
  });
});
