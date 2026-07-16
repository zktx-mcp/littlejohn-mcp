#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareReleasePackage } from "./release/package-audit.mjs";
import { verifyPackagedIntegration } from "./release/packaged-integration.mjs";
import {
  assertSupportedNode,
  sha256File,
  stageVerifiedTarball,
} from "./release/release-support.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

assertSupportedNode();
process.stdout.write("Preparing a clean repository install and staged tarball...\n");
const prepared = await prepareReleasePackage(repositoryRoot);
try {
  process.stdout.write("Verifying packaged owner, deferred peers, MCP, CLI, HTTP, and React...\n");
  await verifyPackagedIntegration(prepared);
  const tarballDigest = await sha256File(prepared.tarballPath);
  const outputPath = process.env["LITTLEJOHN_RELEASE_OUTPUT"];
  const stagedPath = outputPath === undefined
    ? undefined
    : await stageVerifiedTarball(prepared.tarballPath, outputPath);
  process.stdout.write(
    "Automated package verification passed.\n" +
      "This command does not establish public release eligibility or manual host and wallet gates.\n" +
      `Tarball SHA-256: ${tarballDigest}\n` +
      (stagedPath === undefined ? "" : `Verified package artifact: ${stagedPath}\n`),
  );
} finally {
  await prepared.cleanup();
}
