import type { PreparedReleasePackage } from "./package-audit.mjs";

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
