import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCommand } from "../../scripts/release/release-support.mjs";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

let child: ChildProcess;
let stdout: PassThrough;
let stderr: PassThrough;

beforeEach(() => {
  child = new ChildProcess();
  stdout = new PassThrough();
  stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  vi.mocked(spawn).mockReset().mockReturnValue(child);
});

afterEach(() => {
  stdout.destroy();
  stderr.destroy();
});

const close = (code: number | null, signal: NodeJS.Signals | null) => {
  stdout.end();
  stderr.end();
  child.emit("close", code, signal);
};

describe("release command completion", () => {
  it("captures exact stdout and stderr through stream close, including bytes after exit", async () => {
    const environment = { NODE_ENV: "test" };
    const result = runCommand("git", ["ls-files", "--deleted", "-z"], {
      cwd: "/repository",
      env: environment,
      output: "capture",
    });
    stdout.write(Buffer.from("deleted"));
    stderr.write(Buffer.from("warning"));
    child.emit("exit", 0, null);
    stdout.write(Buffer.from(".txt\0renamed.txt\0"));
    stderr.write(Buffer.from("\n"));
    close(0, null);

    const captured = await result;
    expect(captured.stdout).toEqual(Buffer.from("deleted.txt\0renamed.txt\0"));
    expect(captured.stderr).toEqual(Buffer.from("warning\n"));
    expect(spawn).toHaveBeenCalledExactlyOnceWith("git", ["ls-files", "--deleted", "-z"], {
      cwd: "/repository",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("rejects a failed command with its complete stderr rather than an early prefix", async () => {
    const result = runCommand("npm", ["pack", "--json"], { output: "capture" });
    const rejection = expect(result).rejects.toThrow(
      "npm pack --json failed with exit code 7.\npublication failed: complete diagnostic",
    );
    stderr.write("publication failed:");
    child.emit("exit", 7, null);
    stderr.write(" complete diagnostic\n");
    close(7, null);
    await rejection;
  });

  it("preserves signal failure and collects diagnostics until close", async () => {
    const result = runCommand("node", ["worker.js"], { output: "capture" });
    const rejection = expect(result).rejects.toThrow(
      "node worker.js failed with signal SIGTERM.\ninterrupted",
    );
    child.emit("exit", null, "SIGTERM");
    stderr.write("interrupted\n");
    close(null, "SIGTERM");
    await rejection;
  });

  it("preserves the original spawn error after stream cleanup", async () => {
    const failure = Object.assign(new Error("Command does not exist."), { code: "ENOENT" });
    const result = runCommand("missing-command", [], { output: "capture" });
    const rejection = expect(result).rejects.toBe(failure);
    let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    child.emit("error", failure);
    await Promise.resolve();
    const settledBeforeClose = settled;
    close(-2, null);
    await rejection;
    expect(settledBeforeClose).toBe(false);
  });

  it("inherits output without capturing it and waits for command close", async () => {
    child.stdout = null;
    child.stderr = null;
    const result = runCommand("npm", ["run", "build"]);
    let settled = false;
    void result.then(() => { settled = true; });
    child.emit("exit", 0, null);
    await Promise.resolve();
    const settledBeforeClose = settled;
    close(0, null);

    expect(await result).toEqual({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    expect(settledBeforeClose).toBe(false);
    expect(spawn).toHaveBeenCalledExactlyOnceWith("npm", ["run", "build"], {
      cwd: undefined,
      env: undefined,
      stdio: ["ignore", "inherit", "inherit"],
    });
  });
});
