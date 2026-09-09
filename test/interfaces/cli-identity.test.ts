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
      {"domain": "activity", "command": "get", "argumentSyntax": "<transaction-hash> --address <address> [--json]"},
      {"domain": "activity", "command": "inspect", "argumentSyntax": "<transaction-hash> --address <address> [--json]"},
      {"domain": "activity", "command": "list", "argumentSyntax": "--address <address> [--after <transaction-hash>] [--json]"},
      {"domain": "exchange", "command": "cancel-review", "argumentSyntax": "<operation-id> [--json]"},
      {"domain": "exchange", "command": "get-review", "argumentSyntax": "<operation-id> [--json]"},
      {"domain": "exchange", "command": "replace-fees", "argumentSyntax": "<transaction-hash> (--address <address> | --active) --max-fee <wei-per-gas> --priority-fee <wei-per-gas>"},
      {"domain": "exchange", "command": "start", "argumentSyntax": "(--address <address> | --active) --stock-token <address> --direction <buy|sell> --pool <pool-id> --basis <sent|received> --input <token-units> --input-relation <equal|at_most> --output <token-units> --output-relation <equal|at_least> --max-fee <wei-per-gas> --priority-fee <wei-per-gas> --deadline <UTC-time> [--gas-limit <gas>] [--replaces <hash>]"},
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
        argumentSyntax: "(--address <address> | --active) [--limit <1..5>] [--cursor <cursor-json>] [--json]",
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
        argumentSyntax: "<token-address> (--address <address> | --active)",
      },
      { domain: "token", command: "get", argumentSyntax: "<token-address> (--address <address> | --active) [--json]" },
      {
        domain: "token",
        command: "inspect",
        argumentSyntax: "<token-address> --block <latest|block-number> [--json]",
      },
      {
        domain: "token",
        command: "list",
        argumentSyntax: "(--address <address> | --active) [--limit <1..25>] [--cursor <token-address>] [--json]",
      },
      { domain: "token", command: "operation", argumentSyntax: "<operation-id> [--json]" },
      {
        domain: "token",
        command: "remove",
        argumentSyntax: "<token-address> (--address <address> | --active) --revision <revision>",
      },
      {
        domain: "uniswap-v2",
        command: "quote-exact-input",
        argumentSyntax: "--factory <factory-address> --token-in <token-address> --token-out <token-address> --amount-in <raw-uint256> --block <latest|block-number> [--json]",
      },
      { domain: "uniswap-v4", command: "list-pools", argumentSyntax: "<stock-token-address> [--json]" },
      { domain: "wallet", command: "cancel", argumentSyntax: "<operation-id>" },
      { domain: "wallet", command: "connect", argumentSyntax: "" },
      { domain: "wallet", command: "disconnect", argumentSyntax: "" },
      { domain: "wallet", command: "operation", argumentSyntax: "<operation-id> [--json]" },
      { domain: "wallet", command: "status", argumentSyntax: "[--json]" },
    ]);
    expect(cliHelpText).toBe([
      "Usage:",
      "  littlejohn activity get <transaction-hash> --address <address> [--json]",
      "  littlejohn activity inspect <transaction-hash> --address <address> [--json]",
      "  littlejohn activity list --address <address> [--after <transaction-hash>] [--json]",
      "  littlejohn exchange cancel-review <operation-id> [--json]",
      "  littlejohn exchange get-review <operation-id> [--json]",
      "  littlejohn exchange replace-fees <transaction-hash> (--address <address> | --active) --max-fee <wei-per-gas> --priority-fee <wei-per-gas>",
      "  littlejohn exchange start (--address <address> | --active) --stock-token <address> --direction <buy|sell> --pool <pool-id> --basis <sent|received> --input <token-units> --input-relation <equal|at_most> --output <token-units> --output-relation <equal|at_least> --max-fee <wei-per-gas> --priority-fee <wei-per-gas> --deadline <UTC-time> [--gas-limit <gas>] [--replaces <hash>]",
      "  littlejohn market stock-token-trade-history <symbol> [--period <count> --unit <day|week|month|year>] [--json]",
      "  littlejohn read address (<address> | --active) --block <latest|block-number> [--json]",
      "  littlejohn read assets (--address <address> | --active) [--limit <1..5>] [--cursor <cursor-json>] [--json]",
      "  littlejohn read balance (--address <address> | --active) --native <true|false> [--token <address>]... --block <latest|block-number> [--json]",
      "  littlejohn read chain-status [--json]",
      "  littlejohn read transaction <transaction-hash> [--json]",
      "  littlejohn token add <token-address> (--address <address> | --active)",
      "  littlejohn token get <token-address> (--address <address> | --active) [--json]",
      "  littlejohn token inspect <token-address> --block <latest|block-number> [--json]",
      "  littlejohn token list (--address <address> | --active) [--limit <1..25>] [--cursor <token-address>] [--json]",
      "  littlejohn token operation <operation-id> [--json]",
      "  littlejohn token remove <token-address> (--address <address> | --active) --revision <revision>",
      "  littlejohn uniswap-v2 quote-exact-input --factory <factory-address> --token-in <token-address> --token-out <token-address> --amount-in <raw-uint256> --block <latest|block-number> [--json]",
      "  littlejohn uniswap-v4 list-pools <stock-token-address> [--json]",
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
