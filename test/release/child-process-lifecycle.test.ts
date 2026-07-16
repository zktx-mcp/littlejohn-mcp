import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  initializeOwnedChild,
  ownChildProcess,
  type OwnedChildProcess,
} from "../../scripts/release/child-process-lifecycle.mjs";

const children: OwnedChildProcess[] = [];

const startLongLivedChild = (): OwnedChildProcess => {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    "setInterval(() => {}, 1_000);",
  ], {
    stdio: "ignore",
  });
  const ownership = ownChildProcess(child, "Test child", 1_000);
  children.push(ownership);
  return ownership;
};

const startSignalIgnoringChild = async (): Promise<Readonly<{
  exit: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
  ownership: OwnedChildProcess;
}>> => {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'process.on("SIGTERM", () => {});',
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1_000);",
    ].join(""),
  ], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const ownership = ownChildProcess(child, "Signal-ignoring test child", 50);
  children.push(ownership);
  const exit = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
    (resolveExit) => {
      child.once("exit", (code, signal) => resolveExit(Object.freeze({ code, signal })));
    },
  );
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error("Signal-ignoring test child did not become ready.")),
      1_000,
    );
    child.stdout?.once("data", () => {
      clearTimeout(timeout);
      resolveReady();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `Signal-ignoring test child exited before ready (${String(code)}/${String(signal)}).`,
      ));
    });
  });
  return Object.freeze({ exit, ownership });
};

const startInputClosingChild = async (): Promise<OwnedChildProcess> => {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'const { closeSync } = await import("node:fs");',
      "closeSync(0);",
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1_000);",
    ].join(""),
  ], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const ownership = ownChildProcess(child, "Input-closing test child", 1_000);
  children.push(ownership);
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error("Input-closing test child did not become ready.")),
      1_000,
    );
    child.stdout?.once("data", () => {
      clearTimeout(timeout);
      resolveReady();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `Input-closing test child exited before ready (${String(code)}/${String(signal)}).`,
      ));
    });
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  return ownership;
};

afterEach(async () => {
  await Promise.allSettled(children.splice(0).map((ownership) => ownership.terminate()));
});

describe("release child process lifecycle", () => {
  it("terminates the owned child when initialization rejects", async () => {
    const ownership = startLongLivedChild();
    await expect(initializeOwnedChild(
      ownership,
      async () => {
        throw new Error("initialization rejected");
      },
      1_000,
      "Test initialization",
    )).rejects.toThrow("initialization rejected");
    expect(ownership.isTerminated()).toBe(true);
  });

  it("bounds initialization and force-kills a child that ignores graceful shutdown", async () => {
    const { exit, ownership } = await startSignalIgnoringChild();
    await expect(initializeOwnedChild(
      ownership,
      () => new Promise<never>(() => {}),
      25,
      "Test initialization",
    )).rejects.toThrow("Test initialization timed out");
    expect(ownership.isTerminated()).toBe(true);
    const result = await exit;
    if (process.platform !== "win32") {
      expect(result).toEqual({ code: null, signal: "SIGKILL" });
    }
  });

  it("owns a closed stdin failure and terminates the child during initialization", async () => {
    const ownership = await startInputClosingChild();
    await expect(initializeOwnedChild(
      ownership,
      async () => {
        await ownership.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
        await new Promise<never>(() => {});
      },
      1_000,
      "Input-closing child initialization",
    )).rejects.not.toThrow("timed out");
    expect(ownership.isTerminated()).toBe(true);
  });
});
