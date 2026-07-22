import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const serverNamePattern = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/u;
const sha512IntegrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

const record = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;

const ownValue = (value, key) => {
  const source = record(value);
  return source === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(source, key)?.value;
};

/** @type {typeof import("./publication-contract.d.mts").parseReleasePublication} */
export const parseReleasePublication = (
  packageManifest,
  serverManifest,
  releaseTag,
  prerelease,
) => {
  const packageName = ownValue(packageManifest, "name");
  const version = ownValue(packageManifest, "version");
  const serverName = ownValue(packageManifest, "mcpName");
  const description = ownValue(packageManifest, "description");
  const license = ownValue(packageManifest, "license");
  const repository = ownValue(packageManifest, "repository");
  const packageRepositoryUrl = ownValue(repository, "url");
  const packageRepositoryType = ownValue(repository, "type");
  const publishConfig = ownValue(packageManifest, "publishConfig");
  const serverRepository = ownValue(serverManifest, "repository");
  const serverPackage = Array.isArray(ownValue(serverManifest, "packages"))
    ? ownValue(serverManifest, "packages")[0]
    : undefined;
  const expectedWebsite = typeof packageRepositoryUrl === "string"
    ? packageRepositoryUrl.replace(/^git\+/u, "").replace(/\.git$/u, "")
    : undefined;
  const match = typeof version === "string" ? semverPattern.exec(version) : null;
  if (
    typeof packageName !== "string" || packageName.length === 0 || packageName.includes("/") ||
    match === null ||
    typeof serverName !== "string" || !serverNamePattern.test(serverName) ||
    license !== "MIT" ||
    packageRepositoryType !== "git" ||
    packageRepositoryUrl !== "git+https://github.com/stelis-dev/littlejohn-mcp.git" ||
    ownValue(packageManifest, "homepage") !== `${expectedWebsite}#readme` ||
    ownValue(ownValue(packageManifest, "bugs"), "url") !== `${expectedWebsite}/issues` ||
    ownValue(publishConfig, "access") !== "public" ||
    ownValue(publishConfig, "registry") !== "https://registry.npmjs.org" ||
    ownValue(packageManifest, "private") === true ||
    releaseTag !== version && releaseTag !== `v${version}` ||
    typeof prerelease !== "boolean" ||
    (match[4] !== undefined) !== prerelease ||
    ownValue(serverManifest, "name") !== serverName ||
    ownValue(serverManifest, "$schema") !== "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json" ||
    typeof description !== "string" || description.length === 0 ||
    ownValue(serverManifest, "description") !== description ||
    ownValue(serverManifest, "version") !== version ||
    ownValue(serverManifest, "websiteUrl") !== expectedWebsite ||
    ownValue(serverRepository, "url") !== expectedWebsite ||
    ownValue(serverRepository, "source") !== "github" ||
    !Array.isArray(ownValue(serverManifest, "packages")) ||
    ownValue(serverManifest, "packages").length !== 1 ||
    ownValue(serverPackage, "registryType") !== "npm" ||
    ownValue(serverPackage, "identifier") !== packageName ||
    ownValue(serverPackage, "version") !== version ||
    ownValue(ownValue(serverPackage, "transport"), "type") !== "stdio"
  ) throw new TypeError("Release publication identity is inconsistent.");
  return Object.freeze({
    packageName,
    version,
    serverName,
    npmTag: prerelease ? "next" : "latest",
    registerMcp: !prerelease,
  });
};

/** @type {typeof import("./publication-contract.d.mts").npmTarballIntegrity} */
export const npmTarballIntegrity = (bytes) => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError("Release tarball bytes are invalid.");
  }
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
};

/** @type {typeof import("./publication-contract.d.mts").classifyNpmPublication} */
export const classifyNpmPublication = (
  versionDocument,
  distTags,
  publication,
  expectedIntegrity,
) => {
  if (!sha512IntegrityPattern.test(expectedIntegrity)) {
    throw new TypeError("Expected npm integrity is invalid.");
  }
  const versionRecord = record(versionDocument);
  const tagRecord = record(distTags);
  if (
    (versionDocument !== undefined && versionRecord === undefined) ||
    (distTags !== undefined && tagRecord === undefined)
  ) return Object.freeze({ status: "conflict" });
  if (versionDocument === undefined) {
    return Object.freeze({
      status: ownValue(tagRecord, publication.npmTag) === publication.version
        ? "pending"
        : "missing",
    });
  }
  const dist = ownValue(versionRecord, "dist");
  const exactVersion =
    ownValue(versionRecord, "name") === publication.packageName &&
    ownValue(versionRecord, "version") === publication.version &&
    ownValue(dist, "integrity") === expectedIntegrity;
  if (!exactVersion) return Object.freeze({ status: "conflict" });
  return Object.freeze({
    status: ownValue(tagRecord, publication.npmTag) === publication.version
      ? "exact"
      : "pending",
  });
};

/** @type {typeof import("./publication-contract.d.mts").classifyMcpPublication} */
export const classifyMcpPublication = (response, expectedServerManifest) => {
  if (response === undefined) return Object.freeze({ status: "missing" });
  return Object.freeze({
    status: isDeepStrictEqual(ownValue(response, "server"), expectedServerManifest)
      ? "exact"
      : "conflict",
  });
};
