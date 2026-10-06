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
export function packagedToolSchemaBundleSha256(
  tools: readonly Readonly<{
    name: string;
    inputSchema: Readonly<Record<string, unknown>>;
    outputSchema: Readonly<Record<string, unknown>>;
  }>[],
): string;
export function verifyPackagedIntegration(prepared: PreparedReleasePackage): Promise<void>;
