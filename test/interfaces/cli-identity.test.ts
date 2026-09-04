import { describe, expect, it } from "vitest";

import {
  cliHelpText,
  declaredCliCommandIdentities,
} from "../../src/interfaces/identities.js";
import {
  runCli as runCliResult,
  type CliTerminalPort,
} from "../../src/cli.js";

const runCli = async (...input: Parameters<typeof runCliResult>): Promise<number> =>
  (await runCliResult(...input)).exitCode;

const helpTerminal = (): CliTerminalPort & {
  readonly output: string[];
  readonly errors: string[];
  disposed(): boolean;
} => {
  const output: string[] = [];
  const errors: string[] = [];
  let isDisposed = false;
  return Object.freeze({
    inputIsTTY: false,
    outputIsTTY: false,
    columns: undefined,
    rows: undefined,
    interruptSignal: new AbortController().signal,
    output,
    errors,
    writeOutput: (value: string) => { output.push(value); },
    writeError: (value: string) => { errors.push(value); },
    showQr: () => { throw new Error("Help must not display a QR code."); },
    hideQr: () => { throw new Error("Help must not manage a QR code."); },
    readLine: async () => { throw new Error("Help must not read terminal input."); },
    dispose: () => { isDisposed = true; },
    disposed: () => isDisposed,
  });
};

describe("CLI interface identity", () => {
  it("owns the complete command identity and exact accepted syntax in one projection", () => {
    expect(declaredCliCommandIdentities).toEqual([
      {
        domain: "market",
        command: "stock-token-trade-history",
        argumentSyntax: "<symbol> [--period <count> --unit <day|week|month|year>] [--json]",
      },
      {
        domain: "read",
        command: "address",
        argumentSyntax: "(<address> | --active) --block <latest|block-number> [--json]",
      },
      {
        domain: "read",
        command: "assets",
        argumentSyntax: "[--limit <1..5>] [--cursor <cursor-json>] [--json]",
      },
      {
        domain: "read",
        command: "balance",
        argumentSyntax: "(--address <address> | --active) --native <true|false> [--token <address>]... --block <latest|block-number> [--json]",
      },
      { domain: "read", command: "chain-status", argumentSyntax: "[--json]" },
      {
        domain: "read",
        command: "transaction",
        argumentSyntax: "<transaction-hash> [--json]",
      },
      {
        domain: "token",
        command: "add",
        argumentSyntax: "<token-address>",
      },
      { domain: "token", command: "get", argumentSyntax: "<token-address> [--json]" },
      {
        domain: "token",
        command: "inspect",
        argumentSyntax: "<token-address> --block <latest|block-number> [--json]",
      },
      {
        domain: "token",
        command: "list",
        argumentSyntax: "[--limit <1..25>] [--cursor <token-address>] [--json]",
      },
      { domain: "token", command: "operation", argumentSyntax: "<operation-id> [--json]" },
      {
        domain: "token",
        command: "remove",
        argumentSyntax: "<token-address> --revision <revision>",
      },
      {
        domain: "uniswap-v2",
        command: "quote-exact-input",
        argumentSyntax: "--factory <factory-address> --token-in <token-address> --token-out <token-address> --amount-in <raw-uint256> --block <latest|block-number> [--json]",
      },
      { domain: "wallet", command: "cancel", argumentSyntax: "<operation-id>" },
      { domain: "wallet", command: "connect", argumentSyntax: "" },
      { domain: "wallet", command: "disconnect", argumentSyntax: "" },
      { domain: "wallet", command: "operation", argumentSyntax: "<operation-id> [--json]" },
      { domain: "wallet", command: "status", argumentSyntax: "[--json]" },
    ]);
    expect(cliHelpText).toBe([
      "Usage:",
      "  littlejohn market stock-token-trade-history <symbol> [--period <count> --unit <day|week|month|year>] [--json]",
      "  littlejohn read address (<address> | --active) --block <latest|block-number> [--json]",
      "  littlejohn read assets [--limit <1..5>] [--cursor <cursor-json>] [--json]",
      "  littlejohn read balance (--address <address> | --active) --native <true|false> [--token <address>]... --block <latest|block-number> [--json]",
      "  littlejohn read chain-status [--json]",
      "  littlejohn read transaction <transaction-hash> [--json]",
      "  littlejohn token add <token-address>",
      "  littlejohn token get <token-address> [--json]",
      "  littlejohn token inspect <token-address> --block <latest|block-number> [--json]",
      "  littlejohn token list [--limit <1..25>] [--cursor <token-address>] [--json]",
      "  littlejohn token operation <operation-id> [--json]",
      "  littlejohn token remove <token-address> --revision <revision>",
      "  littlejohn uniswap-v2 quote-exact-input --factory <factory-address> --token-in <token-address> --token-out <token-address> --amount-in <raw-uint256> --block <latest|block-number> [--json]",
      "  littlejohn wallet cancel <operation-id>",
      "  littlejohn wallet connect",
      "  littlejohn wallet disconnect",
      "  littlejohn wallet operation <operation-id> [--json]",
      "  littlejohn wallet status [--json]",
      "  littlejohn --help",
      "",
    ].join("\n"));
  });

  it("prints help without a TTY or local runtime", async () => {
    const terminal = helpTerminal();
    let runtimeCreations = 0;
    expect(await runCli(["--help"], {
      createRuntime: async () => {
        runtimeCreations += 1;
        throw new Error("Help must not create the local runtime.");
      },
      terminal,
      waitForPoll: async () => undefined,
      createMcp: () => { throw new Error("Help must not create MCP."); },
    })).toBe(0);
    expect(runtimeCreations).toBe(0);
    expect(terminal.output).toEqual([cliHelpText]);
    expect(terminal.errors).toEqual([]);
    expect(terminal.disposed()).toBe(true);
  });
});
