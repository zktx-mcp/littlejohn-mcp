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

export interface ReleasePublicationDependencies {
  readonly validateMcp: (publication: ReleasePublication) => Promise<void>;
  readonly readNpm: (publication: ReleasePublication) => Promise<NpmRemoteState>;
  readonly publishNpm: (
    publication: ReleasePublication,
    artifactPath: string,
  ) => Promise<void>;
  readonly readMcp: (publication: ReleasePublication) => Promise<unknown | undefined>;
  readonly publishMcp: (publication: ReleasePublication) => Promise<void>;
  readonly wait: () => Promise<void>;
}

export interface ReleasePublicationResult {
  readonly npm: "published" | "already_published";
  readonly mcp: "published" | "already_published" | "not_applicable";
}

export function publishRelease(
  input: ReleasePublicationInput,
  dependencies: ReleasePublicationDependencies,
): Promise<ReleasePublicationResult>;
