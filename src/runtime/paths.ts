import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { resolve } from "node:path";

import { productDisplayName } from "../core/index.js";

export interface RuntimePaths {
  readonly dataDirectory: string;
  readonly database: string;
  readonly walletConnectDirectory: string;
  readonly controlCredential: string;
}

export type OwnerOnlyStateFileFailure = "type" | "owner" | "permissions" | "size";

export class OwnerOnlyStateFileError extends Error {
  readonly failure: OwnerOnlyStateFileFailure;

  constructor(failure: OwnerOnlyStateFileFailure) {
    super(`Owner-only state file ${failure} is invalid.`);
    this.name = "OwnerOnlyStateFileError";
    this.failure = failure;
    Object.freeze(this);
  }
}

export interface OwnerOnlyStateFileSize {
  readonly exact?: number;
  readonly maximum?: number;
}

export interface OwnerOnlyStateFileLease {
  assertCurrent(): void;
  stat(): Stats;
  read(buffer: Buffer, offset: number, length: number, position: number): number;
  close(): void;
}

export type OwnerOnlyStateFileLeaseFactory = (
  path: string,
  size?: OwnerOnlyStateFileSize,
) => OwnerOnlyStateFileLease;

const assertSizeConstraint = (constraint: OwnerOnlyStateFileSize): void => {
  if (
    (constraint.exact !== undefined && (!Number.isSafeInteger(constraint.exact) || constraint.exact < 0)) ||
    (constraint.maximum !== undefined && (!Number.isSafeInteger(constraint.maximum) || constraint.maximum < 0)) ||
    (constraint.exact !== undefined && constraint.maximum !== undefined && constraint.exact > constraint.maximum)
  ) throw new TypeError("Owner-only state file size constraint is invalid.");
};

const assertOwnerOnlyStateFileDetails = (
  details: Stats,
  size: OwnerOnlyStateFileSize,
): void => {
  assertSizeConstraint(size);
  if (!details.isFile() || details.isSymbolicLink()) throw new OwnerOnlyStateFileError("type");
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
      throw new OwnerOnlyStateFileError("owner");
    }
    if ((details.mode & 0o777) !== 0o600) throw new OwnerOnlyStateFileError("permissions");
  }
  if (size.exact !== undefined && details.size !== size.exact) {
    throw new OwnerOnlyStateFileError("size");
  }
  if (size.maximum !== undefined && details.size > size.maximum) {
    throw new OwnerOnlyStateFileError("size");
  }
};

export const attestOwnerOnlyStateFile = async (
  path: string,
  size: OwnerOnlyStateFileSize = {},
): Promise<void> => {
  assertOwnerOnlyStateFileDetails(await lstat(path), size);
};

export const openOwnerOnlyStateFileForRead = async (
  path: string,
  size: OwnerOnlyStateFileSize = {},
): Promise<FileHandle> => {
  await attestOwnerOnlyStateFile(path, size);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new OwnerOnlyStateFileError("type");
    }
    throw error;
  }
  try {
    assertOwnerOnlyStateFileDetails(await handle.stat(), size);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const sameFileIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

export const acquireOwnerOnlyStateFileLease: OwnerOnlyStateFileLeaseFactory = (
  path,
  size = {},
) => {
  assertOwnerOnlyStateFileDetails(lstatSync(path), size);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new OwnerOnlyStateFileError("type");
    }
    throw error;
  }

  let closed = false;
  const currentDescriptorDetails = (): Stats => {
    if (closed) throw new Error("Owner-only state file lease is closed.");
    const details = fstatSync(descriptor);
    assertOwnerOnlyStateFileDetails(details, size);
    return details;
  };
  const assertCurrent = (): void => {
    const pathDetails = lstatSync(path);
    assertOwnerOnlyStateFileDetails(pathDetails, size);
    if (!sameFileIdentity(currentDescriptorDetails(), pathDetails)) {
      throw new OwnerOnlyStateFileError("type");
    }
  };

  try { assertCurrent(); }
  catch (error) {
    closeSync(descriptor);
    closed = true;
    throw error;
  }

  return Object.freeze({
    assertCurrent,
    stat: currentDescriptorDetails,
    read: (buffer: Buffer, offset: number, length: number, position: number): number => {
      currentDescriptorDetails();
      return readSync(descriptor, buffer, offset, length, position);
    },
    close: (): void => {
      if (closed) return;
      closeSync(descriptor);
      closed = true;
    },
  });
};

export const createOwnerOnlyStateFileForWrite = async (path: string): Promise<FileHandle> => {
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
    assertOwnerOnlyStateFileDetails(await handle.stat(), { exact: 0 });
    return handle;
  } catch (error) {
    try { await handle.close(); } catch { /* Preserve the creation failure. */ }
    try { await unlink(path); } catch { /* Preserve the creation failure. */ }
    throw error;
  }
};

export const createOwnerOnlyStateFile = async (path: string): Promise<void> => {
  const handle = await createOwnerOnlyStateFileForWrite(path);
  await handle.close();
};

export const resolveApplicationDataDirectory = (
  environment: Readonly<Record<string, string | undefined>>,
  operatingSystem = platform(),
  homeDirectory = homedir(),
): string => {
  const override = environment["LITTLEJOHN_DATA_DIR"];
  if (override !== undefined) {
    if (override.length === 0) throw new TypeError("LITTLEJOHN_DATA_DIR cannot be empty.");
    return resolve(override);
  }
  if (operatingSystem === "darwin") return resolve(homeDirectory, "Library/Application Support/Littlejohn");
  if (operatingSystem === "linux") {
    const stateHome = environment["XDG_STATE_HOME"];
    return stateHome === undefined || stateHome.length === 0
      ? resolve(homeDirectory, ".local/state/littlejohn")
      : resolve(stateHome, "littlejohn");
  }
  if (operatingSystem === "win32") {
    const localAppData = environment["LOCALAPPDATA"];
    if (localAppData === undefined || localAppData.length === 0) {
      throw new TypeError("LOCALAPPDATA is required on Windows.");
    }
    return resolve(localAppData, "Littlejohn");
  }
  throw new TypeError(`The operating system has no ${productDisplayName} data-directory contract.`);
};

export const runtimePaths = (dataDirectory: string): RuntimePaths => Object.freeze({
  dataDirectory,
  database: resolve(dataDirectory, "littlejohn.sqlite3"),
  walletConnectDirectory: resolve(dataDirectory, "walletconnect"),
  controlCredential: resolve(dataDirectory, "local-control-credential"),
});

export const ensureOwnerOnlyDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Application data path is not a regular directory.");
  }
  if (process.platform === "win32") return;
  if ((details.mode & 0o077) !== 0) throw new Error("Application data directory is not owner-only.");
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error("Application data directory has a foreign owner.");
  }
};
