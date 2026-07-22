#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  classifyMcpPublication,
  classifyNpmPublication,
  npmTarballIntegrity,
  parseReleasePublication,
} from "./publication-contract.mjs";
import { readJsonFile, runCommand } from "./release-support.mjs";

const verificationAttempts = 12;
const responseLimitBytes = 4 * 1024 * 1024;

const verificationFailure = (registry) =>
  new Error(`${registry} did not expose the exact committed release state.`);

const readNpmClassification = async (
  dependencies,
  publication,
  integrity,
) => {
  const remote = await dependencies.readNpm(publication);
  return classifyNpmPublication(
    remote.versionDocument,
    remote.distTags,
    publication,
    integrity,
  ).status;
};

const verifyNpmCommit = async (dependencies, publication, integrity) => {
  for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
    const status = await readNpmClassification(dependencies, publication, integrity);
    if (status === "exact") return;
    if (status === "conflict") throw new Error("npm contains a conflicting release version.");
    if (attempt + 1 < verificationAttempts) await dependencies.wait();
  }
  throw verificationFailure("npm");
};

const verifyMcpCommit = async (dependencies, publication, serverManifest) => {
  for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
    const status = classifyMcpPublication(
      await dependencies.readMcp(publication),
      serverManifest,
    ).status;
    if (status === "exact") return;
    if (status === "conflict") throw new Error("MCP Registry contains a conflicting release version.");
    if (attempt + 1 < verificationAttempts) await dependencies.wait();
  }
  throw verificationFailure("MCP Registry");
};

/** @type {typeof import("./publish-release.d.mts").publishRelease} */
export const publishRelease = async (input, dependencies) => {
  const publication = parseReleasePublication(
    input.packageManifest,
    input.serverManifest,
    input.releaseTag,
    input.prerelease,
  );
  if (!isAbsolute(input.artifactPath)) {
    throw new TypeError("Verified release artifact path must be absolute.");
  }
  const integrity = npmTarballIntegrity(input.artifactBytes);
  if (publication.registerMcp) await dependencies.validateMcp(publication);
  const initialNpm = await readNpmClassification(dependencies, publication, integrity);
  /** @type {"published" | "already_published"} */
  let npmResult;
  if (initialNpm === "conflict") throw new Error("npm contains a conflicting release version.");
  if (initialNpm === "exact") {
    npmResult = "already_published";
  } else if (initialNpm === "pending") {
    await verifyNpmCommit(dependencies, publication, integrity);
    npmResult = "already_published";
  } else {
    let commitError;
    try {
      await dependencies.publishNpm(publication, input.artifactPath);
    } catch (error) {
      commitError = error;
    }
    try {
      await verifyNpmCommit(dependencies, publication, integrity);
    } catch (verificationError) {
      if (commitError === undefined) throw verificationError;
      throw new AggregateError(
        [commitError, verificationError],
        "npm publication failed and exact committed state was not recovered.",
      );
    }
    npmResult = "published";
  }

  if (!publication.registerMcp) {
    return Object.freeze({ npm: npmResult, mcp: "not_applicable" });
  }
  const initialMcp = classifyMcpPublication(
    await dependencies.readMcp(publication),
    input.serverManifest,
  ).status;
  if (initialMcp === "conflict") {
    throw new Error("MCP Registry contains a conflicting release version.");
  }
  /** @type {"published" | "already_published"} */
  let mcpResult;
  if (initialMcp === "exact") {
    mcpResult = "already_published";
  } else {
    let commitError;
    try {
      await dependencies.publishMcp(publication);
    } catch (error) {
      commitError = error;
    }
    try {
      await verifyMcpCommit(dependencies, publication, input.serverManifest);
    } catch (verificationError) {
      if (commitError === undefined) throw verificationError;
      throw new AggregateError(
        [commitError, verificationError],
        "MCP Registry publication failed and exact committed state was not recovered.",
      );
    }
    mcpResult = "published";
  }
  return Object.freeze({ npm: npmResult, mcp: mcpResult });
};

const boundedJson = async (response, label) => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new TypeError(`${label} response body is unavailable.`);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > responseLimitBytes) {
      await reader.cancel();
      throw new TypeError(`${label} response exceeds its byte limit.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TypeError(`${label} response is not valid UTF-8 JSON.`); }
};

const fetchJsonOrMissing = async (url, label) => {
  const response = await fetch(url, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`${label} read failed with HTTP ${response.status}.`);
  }
  return boundedJson(response, label);
};

const assertNpmOidcVersion = async () => {
  const output = (await runCommand("npm", ["--version"], { output: "capture" })).stdout
    .toString("utf8").trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(output);
  if (
    match === null ||
    Number(match[1]) < 11 ||
    (Number(match[1]) === 11 && (
      Number(match[2]) < 5 ||
      (Number(match[2]) === 5 && Number(match[3]) < 1)
    ))
  ) throw new TypeError("Automatic npm publication requires npm 11.5.1 or newer.");
};

const main = async () => {
  const releaseTag = process.env["GITHUB_RELEASE_TAG"];
  const prereleaseText = process.env["GITHUB_RELEASE_PRERELEASE"];
  const artifactPath = process.env["LITTLEJOHN_RELEASE_OUTPUT"];
  if (
    releaseTag === undefined ||
    (prereleaseText !== "true" && prereleaseText !== "false") ||
    artifactPath === undefined ||
    !isAbsolute(artifactPath)
  ) throw new TypeError("GitHub release publication environment is invalid.");
  const prerelease = prereleaseText === "true";
  const [packageManifest, serverManifest, artifactBytes, artifactDetails] = await Promise.all([
    readJsonFile(resolve("package.json")),
    readJsonFile(resolve("server.json")),
    readFile(artifactPath),
    lstat(artifactPath),
  ]);
  if (!artifactDetails.isFile() || artifactDetails.isSymbolicLink() || artifactDetails.size === 0) {
    throw new TypeError("Verified release artifact is not a nonempty regular file.");
  }
  await assertNpmOidcVersion();
  const publisherPath = process.env["MCP_PUBLISHER_PATH"];
  if (!prerelease) {
    if (publisherPath === undefined || !isAbsolute(publisherPath)) {
      throw new TypeError("Stable release MCP publisher path is invalid.");
    }
    const publisherDetails = await lstat(publisherPath);
    if (!publisherDetails.isFile() || publisherDetails.isSymbolicLink()) {
      throw new TypeError("Stable release MCP publisher is not a regular file.");
    }
  }

  const npmVersionUrl = (publication) =>
    `https://registry.npmjs.org/${encodeURIComponent(publication.packageName)}/${encodeURIComponent(publication.version)}`;
  const npmTagsUrl = (publication) =>
    `https://registry.npmjs.org/-/package/${encodeURIComponent(publication.packageName)}/dist-tags`;
  const mcpVersionUrl = (publication) =>
    `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(publication.serverName)}/versions/${encodeURIComponent(publication.version)}`;
  const mcpPublisherEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "NODE_AUTH_TOKEN"),
  );
  const result = await publishRelease({
    packageManifest,
    serverManifest,
    releaseTag,
    prerelease,
    artifactPath,
    artifactBytes,
  }, {
    validateMcp: async () => {
      if (publisherPath === undefined) {
        throw new TypeError("Stable release MCP publisher path is unavailable.");
      }
      await runCommand(publisherPath, ["validate", "server.json"], {
        env: mcpPublisherEnvironment,
      });
    },
    readNpm: async (publication) => {
      const [versionDocument, distTags] = await Promise.all([
        fetchJsonOrMissing(npmVersionUrl(publication), "npm version"),
        fetchJsonOrMissing(npmTagsUrl(publication), "npm dist-tags"),
      ]);
      return Object.freeze({ versionDocument, distTags });
    },
    publishNpm: async (publication, verifiedArtifactPath) => {
      await runCommand("npm", [
        "publish",
        verifiedArtifactPath,
        "--ignore-scripts",
        "--access",
        "public",
        "--registry",
        "https://registry.npmjs.org",
        "--tag",
        publication.npmTag,
        "--provenance",
      ]);
    },
    readMcp: (publication) =>
      fetchJsonOrMissing(mcpVersionUrl(publication), "MCP Registry version"),
    publishMcp: async () => {
      if (publisherPath === undefined) {
        throw new TypeError("Stable release MCP publisher path is unavailable.");
      }
      await runCommand(publisherPath, ["login", "github-oidc"], {
        env: mcpPublisherEnvironment,
      });
      await runCommand(publisherPath, ["publish", "server.json"], {
        env: mcpPublisherEnvironment,
      });
    },
    wait: () => new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  });
  process.stdout.write(`Release publication completed: ${JSON.stringify(result)}\n`);
};

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await main();
}
