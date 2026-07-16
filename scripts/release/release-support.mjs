import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** @type {typeof import("./release-support.d.mts").sha256} */
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** @type {typeof import("./release-support.d.mts").sha256File} */
export const sha256File = async (path) => sha256(await readFile(path));

/** @type {typeof import("./release-support.d.mts").stageVerifiedTarball} */
export const stageVerifiedTarball = async (sourcePath, outputPath) => {
  if (typeof outputPath !== "string" || outputPath.length === 0 || !isAbsolute(outputPath)) {
    throw new TypeError("Verified tarball output path must be absolute.");
  }
  const source = resolve(sourcePath);
  const target = resolve(outputPath);
  if (source === target) throw new TypeError("Verified tarball output must differ from its source.");
  const directory = dirname(target);
  const temporary = resolve(directory, `.${target.split(sep).at(-1)}.tmp-${process.pid}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rm(temporary, { force: true });
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  const details = await lstat(target);
  if (!details.isFile() || details.isSymbolicLink() || details.size === 0) {
    throw new TypeError("Verified tarball output is not a regular file.");
  }
  return target;
};

/** @type {typeof import("./release-support.d.mts").canonicalRelativePath} */
export const canonicalRelativePath = (value) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError("Path is not a canonical relative path.");
  }
  return value;
};

/** @type {typeof import("./release-support.d.mts").runCommand} */
export const runCommand = (
  command,
  arguments_,
  {
    cwd,
    env,
    output = "inherit",
  } = {},
) => new Promise((resolveRun, rejectRun) => {
  const capture = output === "capture";
  const child = spawn(command, arguments_, {
    cwd,
    env,
    stdio: [
      "ignore",
      capture ? "pipe" : "inherit",
      capture ? "pipe" : "inherit",
    ],
  });
  const stdout = [];
  const stderr = [];
  child.stdout?.on("data", (chunk) => { stdout.push(Buffer.from(chunk)); });
  child.stderr?.on("data", (chunk) => { stderr.push(Buffer.from(chunk)); });
  child.once("error", rejectRun);
  child.once("exit", (code, signal) => {
    if (code === 0 && signal === null) {
      resolveRun(Object.freeze({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }));
      return;
    }
    const detail = signal === null ? `exit code ${code}` : `signal ${signal}`;
    const capturedError = Buffer.concat(stderr).toString("utf8").trim();
    rejectRun(new Error(
      `${command} ${arguments_.join(" ")} failed with ${detail}.` +
      (capturedError.length === 0 ? "" : `\n${capturedError}`),
    ));
  });
});

/** @type {typeof import("./release-support.d.mts").assertSupportedNode} */
export const assertSupportedNode = () => {
  const [majorText, minorText] = process.versions.node.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    major < 22 ||
    (major === 22 && minor < 12)
  ) {
    throw new TypeError("Release verification requires Node.js 22.12.0 or newer.");
  }
};

const gitSourcePaths = async (repositoryRoot) => {
  const result = await runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, output: "capture" },
  );
  const decoded = utf8Decoder.decode(result.stdout);
  const paths = decoded.split("\0").filter((value) => value.length !== 0);
  const unique = new Set();
  for (const path of paths) {
    const canonical = canonicalRelativePath(path);
    if (unique.has(canonical)) throw new TypeError("Repository source path is duplicated.");
    unique.add(canonical);
  }
  return Object.freeze([...unique].sort());
};

/** @type {typeof import("./release-support.d.mts").copyRepositorySource} */
export const copyRepositorySource = async (repositoryRoot, destinationRoot) => {
  const sourceRoot = resolve(repositoryRoot);
  const destination = resolve(destinationRoot);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const paths = await gitSourcePaths(sourceRoot);
  for (const path of paths) {
    const source = resolve(sourceRoot, path);
    const fromRoot = relative(sourceRoot, source);
    if (
      isAbsolute(fromRoot) ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`)
    ) throw new TypeError("Repository source path escapes its root.");
    const details = await lstat(source);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new TypeError(`Repository source must be a regular file: ${path}`);
    }
    const target = resolve(destination, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    await chmod(target, details.mode & 0o777);
  }
  return paths;
};

/** @type {typeof import("./release-support.d.mts").parsePackOutput} */
export const parsePackOutput = (bytes) => {
  let value;
  try { value = JSON.parse(utf8Decoder.decode(bytes)); }
  catch { throw new TypeError("npm pack output is invalid JSON."); }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new TypeError("npm pack must return exactly one package record.");
  }
  const record = value[0];
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new TypeError("npm pack returned an invalid package record.");
  }
  const filename = Object.getOwnPropertyDescriptor(record, "filename")?.value;
  if (
    typeof filename !== "string" ||
    filename.length === 0 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0")
  ) throw new TypeError("npm pack returned an invalid filename.");
  const files = Object.getOwnPropertyDescriptor(record, "files")?.value;
  if (!Array.isArray(files) || Object.getPrototypeOf(files) !== Array.prototype) {
    throw new TypeError("npm pack returned an invalid file list.");
  }
  const paths = [];
  const unique = new Set();
  for (const file of files) {
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      throw new TypeError("npm pack returned an invalid file entry.");
    }
    const path = canonicalRelativePath(Object.getOwnPropertyDescriptor(file, "path")?.value);
    if (unique.has(path)) throw new TypeError("npm pack returned a duplicate file path.");
    unique.add(path);
    paths.push(path);
  }
  return Object.freeze({ filename, paths: Object.freeze(paths.sort()) });
};

/** @type {typeof import("./release-support.d.mts").collectRegularFiles} */
export const collectRegularFiles = async (root, directory = root) => {
  const rootPath = resolve(root);
  const current = resolve(directory);
  const details = await lstat(current);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new TypeError("Package tree must contain only regular directories and files.");
  }
  const paths = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await collectRegularFiles(rootPath, path));
    } else if (entry.isFile()) {
      const relativePath = relative(rootPath, path).split(sep).join("/");
      paths.push(canonicalRelativePath(relativePath));
    } else {
      throw new TypeError("Package tree must contain only regular directories and files.");
    }
  }
  return paths.sort();
};

/** @type {typeof import("./release-support.d.mts").assertExactPaths} */
export const assertExactPaths = (actual, expected, label) => {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new TypeError(`${label} file set does not match its authority.`);
  }
};

/** @type {typeof import("./release-support.d.mts").readJsonFile} */
export const readJsonFile = async (path) => {
  try { return JSON.parse(utf8Decoder.decode(await readFile(path))); }
  catch { throw new TypeError(`JSON file is invalid: ${path}`); }
};
