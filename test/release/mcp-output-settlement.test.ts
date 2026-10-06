import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { expect, it } from "vitest";

import { ownChildProcess } from "../../scripts/release/child-process-lifecycle.mjs";
import { RawMcpClient } from "../../scripts/release/packaged-integration.mjs";

it("admits a complete MCP response after process exit and rejects incomplete work only at stream close", async () => {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  const ownership = ownChildProcess(child, "MCP output fixture", 1_000);
  const client = new RawMcpClient(ownership, { name: "fixture", version: "1.0.0" });
  try {
    const response = client.listTools();
    child.emit("exit", 0, null);
    stdout.write('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n');
    await expect(response).resolves.toEqual([]);
    const incomplete = client.listTools();
    const rejected = expect(incomplete).rejects.toThrow("with code 0");
    stdout.end('{"jsonrpc":"2.0","id":2');
    stderr.end();
    child.emit("close", 0, null);
    await rejected;
    await ownership.termination;
  } finally {
    stdout.destroy();
    stderr.destroy();
    stdin.destroy();
  }
});
