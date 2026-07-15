import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertWalletConnectPrivateStore,
  secureWalletConnectPrivateStore,
} from "../../src/wallet/private-store.js";

const directories: string[] = [];

const privateRoot = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "littlejohn-wallet-private-store-"));
  directories.push(root);
  if (process.platform !== "win32") await chmod(root, 0o700);
  return root;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("WalletConnect private storage", () => {
  it("keeps later SDK-style directory and file creation owner-only", async () => {
    const root = await privateRoot();
    await secureWalletConnectPrivateStore(root);
    const nested = resolve(root, "wc@2", "client");
    const file = resolve(nested, "keychain");
    await mkdir(nested, { recursive: true });
    await writeFile(file, "opaque-walletconnect-state");

    await expect(assertWalletConnectPrivateStore(root)).resolves.toBeUndefined();
    if (process.platform !== "win32") {
      expect((await lstat(nested)).mode & 0o777).toBe(0o700);
      expect((await lstat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects permissive existing directories and files instead of repairing them",
    async () => {
      for (const kind of ["directory", "file"] as const) {
        const root = await privateRoot();
        const target = resolve(root, kind);
        if (kind === "directory") {
          await mkdir(target, { mode: 0o700 });
          await chmod(target, 0o755);
        } else {
          await writeFile(target, "opaque-walletconnect-state", { mode: 0o600 });
          await chmod(target, 0o644);
        }
        await expect(secureWalletConnectPrivateStore(root))
          .rejects.toThrow("WalletConnect private storage is invalid.");
      }
    },
  );

  it.runIf(process.platform !== "win32")("rejects symbolic links", async () => {
    const root = await privateRoot();
    const target = resolve(root, "target");
    await writeFile(target, "opaque-walletconnect-state", { mode: 0o600 });
    await chmod(target, 0o600);
    await symlink(target, resolve(root, "alias"));
    await expect(secureWalletConnectPrivateStore(root))
      .rejects.toThrow("WalletConnect private storage is invalid.");
  });
});
