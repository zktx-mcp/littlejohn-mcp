export interface ReleasePublication {
  readonly packageName: string;
  readonly version: string;
  readonly serverName: string;
  readonly npmTag: "latest" | "next";
  readonly registerMcp: boolean;
}

export interface NpmPublicationState {
  readonly status: "missing" | "pending" | "exact" | "conflict";
}

export interface McpPublicationState {
  readonly status: "missing" | "exact" | "conflict";
}

export function parseReleasePublication(
  packageManifest: unknown,
  serverManifest: unknown,
  releaseTag: string,
  prerelease: boolean,
): ReleasePublication;

export function npmTarballIntegrity(bytes: Uint8Array): string;

export function classifyNpmPublication(
  versionDocument: unknown | undefined,
  distTags: unknown | undefined,
  publication: ReleasePublication,
  expectedIntegrity: string,
): NpmPublicationState;

export function classifyMcpPublication(
  response: unknown | undefined,
  expectedServerManifest: unknown,
): McpPublicationState;
