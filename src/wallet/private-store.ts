import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const ownerOnlyCreationMask = 0o077;

const invalidPrivateStore = (): TypeError =>
  new TypeError("WalletConnect private storage is invalid.");

const assertOwner = (uid: number): void => {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw invalidPrivateStore();
  }
};

const assertPrivateEntry = async (path: string): Promise<void> => {
  const details = await lstat(path);
  if (details.isSymbolicLink()) throw invalidPrivateStore();

  if (details.isDirectory()) {
    if (process.platform !== "win32") {
      assertOwner(details.uid);
      if ((details.mode & 0o777) !== privateDirectoryMode) throw invalidPrivateStore();
    }
    const entries = await readdir(path);
    for (const entry of entries) await assertPrivateEntry(resolve(path, entry));
    return;
  }

  if (!details.isFile()) throw invalidPrivateStore();
  if (process.platform !== "win32") {
    assertOwner(details.uid);
    if ((details.mode & 0o777) !== privateFileMode) throw invalidPrivateStore();
  }
};

export const assertWalletConnectPrivateStore = async (path: string): Promise<void> => {
  await assertPrivateEntry(path);
};

export const secureWalletConnectPrivateStore = async (path: string): Promise<void> => {
  if (process.platform !== "win32") {
    const currentMask = process.umask();
    process.umask(currentMask | ownerOnlyCreationMask);
  }
  await assertWalletConnectPrivateStore(path);
};
