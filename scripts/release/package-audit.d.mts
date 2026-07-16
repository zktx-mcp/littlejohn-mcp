export interface ReleasePackageIdentity {
  readonly name: string;
  readonly version: string;
  readonly installRelativePath: string;
}

export interface PreparedReleasePackage {
  readonly environment: NodeJS.ProcessEnv;
  readonly extractedPackageRoot: string;
  readonly installRoot: string;
  readonly installedPackageRoot: string;
  readonly npxRoot: string;
  readonly packageIdentity: ReleasePackageIdentity;
  readonly sourceRoot: string;
  readonly tarballPath: string;
  readonly workspace: string;
  cleanup(): Promise<void>;
}

export interface ReleaseDependencyNode {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, ReleaseDependencyNode>>;
  readonly optionalPeerDependencies: readonly string[];
}

export function dependencyGraphDifferences(
  repository: ReleaseDependencyNode,
  consumer: ReleaseDependencyNode,
): readonly string[];
export function parseReleasePackageIdentity(value: unknown): ReleasePackageIdentity;
export function prepareReleasePackage(repositoryRoot: string): Promise<PreparedReleasePackage>;
