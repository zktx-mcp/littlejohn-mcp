export interface CommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface RunCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly output?: "capture" | "inherit";
}

export interface PackOutput {
  readonly filename: string;
  readonly paths: readonly string[];
}

export function sha256(bytes: Uint8Array): string;
export function sha256File(path: string): Promise<string>;
export function stageVerifiedTarball(sourcePath: string, outputPath: string): Promise<string>;
export function canonicalRelativePath(value: unknown): string;
/** Settles after the command and its stdio close, preserving captured bytes and execution failures. */
export function runCommand(
  command: string,
  arguments_: readonly string[],
  options?: RunCommandOptions,
): Promise<CommandResult>;
export function assertSupportedNode(version?: string): void;
export function copyRepositorySource(
  repositoryRoot: string,
  destinationRoot: string,
): Promise<readonly string[]>;
export function parsePackOutput(bytes: Uint8Array): PackOutput;
export function collectRegularFiles(
  root: string,
  directory?: string,
): Promise<readonly string[]>;
export function assertExactPaths(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void;
export function assertExactFileBytes(
  authorityRoot: string,
  candidateRoot: string,
  paths: readonly string[],
  label: string,
): Promise<void>;
export function readJsonFile(path: string): Promise<unknown>;
