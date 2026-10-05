import type { ReleasePublication } from "./publication-contract.mjs";

export interface ReleasePublicationInput {
  readonly packageManifest: unknown;
  readonly serverManifest: unknown;
  readonly releaseTag: string;
  readonly prerelease: boolean;
  readonly artifactPath: string;
  readonly artifactBytes: Uint8Array;
}

export interface NpmRemoteState {
  readonly versionDocument: unknown | undefined;
  readonly distTags: unknown | undefined;
}

export interface NpmReadOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export function readNpmPublication(
  publication: ReleasePublication,
  options?: NpmReadOptions,
): Promise<NpmRemoteState>;

export interface ReleasePublicationDependencies {
  readonly validateMcp: (publication: ReleasePublication) => Promise<void>;
  readonly readNpm: (publication: ReleasePublication, timeoutMs?: number) => Promise<NpmRemoteState>;
  readonly publishNpm: (
    publication: ReleasePublication,
    artifactPath: string,
  ) => Promise<void>;
  readonly readMcp: (publication: ReleasePublication) => Promise<unknown | undefined>;
  readonly publishMcp: (publication: ReleasePublication) => Promise<void>;
  readonly now?: () => number;
  readonly wait: (milliseconds: number) => Promise<void>;
}

export interface NpmPublicationResult {
  readonly npm: "published" | "already_published";
  readonly integrity: string;
}

export interface McpPublicationInput {
  readonly packageManifest: unknown;
  readonly serverManifest: unknown;
  readonly releaseTag: string;
  readonly prerelease: boolean;
  readonly artifactIntegrity: string;
}

export function publishNpmRelease(
  input: ReleasePublicationInput,
  dependencies: Pick<ReleasePublicationDependencies, "validateMcp" | "readNpm" | "publishNpm" | "now" | "wait">,
): Promise<NpmPublicationResult>;

export function publishMcpRelease(
  input: McpPublicationInput,
  dependencies: Pick<ReleasePublicationDependencies, "validateMcp" | "readNpm" | "readMcp" | "publishMcp" | "now" | "wait">,
): Promise<{ readonly mcp: "published" | "already_published" | "not_applicable" }>;
