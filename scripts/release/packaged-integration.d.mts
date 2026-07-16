import type { PreparedReleasePackage } from "./package-audit.mjs";

export function assertPackagedMcpServerIdentity(
  result: unknown,
  expected: Readonly<{ name: string; version: string }>,
): void;
export function verifyPackagedIntegration(prepared: PreparedReleasePackage): Promise<void>;
