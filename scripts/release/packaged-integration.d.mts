import type { PreparedReleasePackage } from "./package-audit.mjs";
import type { OwnedChildProcess } from "./child-process-lifecycle.mjs";

export class RawMcpClient {
  constructor(ownership: OwnedChildProcess, expectedServerIdentity: Readonly<{ name: string; version: string }>, appConnection?: boolean);
  listTools(): Promise<readonly unknown[]>;
}

export function assertPackagedMcpServerIdentity(
  result: unknown,
  expected: Readonly<{ name: string; version: string }>,
): void;
export function assertPackagedWalletConnection(data: unknown): void;
export function assertPackagedCatalogIdentity(success: unknown, expectedMembers: readonly unknown[], observedAt: string, label: string): void;
export function assertPackagedHistorySourceIdentity(success: unknown, expectedArchive: Readonly<{
  observedAt: string;
  root: Readonly<Record<string, unknown>>;
  base: Readonly<{ baseCurrencyAddress: string; decimals: number; state: Readonly<Record<string, unknown>> }>;
  monthMembers: readonly unknown[];
  resolutionMembers: readonly unknown[];
  pools: Readonly<Record<string, unknown>>;
}>, label: string): void;
export function packagedToolSchemaBundleSha256(
  tools: readonly Readonly<{
    name: string;
    inputSchema: Readonly<Record<string, unknown>>;
    outputSchema: Readonly<Record<string, unknown>>;
  }>[],
): string;
export function derivePackagedLargeHistorySourceArtifact(source: unknown): Readonly<{
  source: string;
  limitation: string;
  artifact: Readonly<{
    baseAddress: string;
    rootName: string;
    rootBase64: string;
    assets: readonly Readonly<{ assetName: string; base64: string }>[];
  }>;
}>;
export function verifyPackagedIntegration(prepared: PreparedReleasePackage): Promise<void>;

export function assertPackagedCanonicalReadSchemas(tools: readonly Readonly<{
  name: string;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema: Readonly<Record<string, unknown>>;
}>[]): void;
