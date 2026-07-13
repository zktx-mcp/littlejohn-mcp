import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonStringify,
  coreContractVersion,
  projectCapabilities,
  readCapabilityRegistry,
  type CanonicalJson,
} from "../core/index.js";

const outputPath = resolve(dirname(fileURLToPath(import.meta.url)), "../generated/capabilities.json");
const output = {
  generatedFrom: "src/core/capabilities.ts",
  contractVersion: coreContractVersion,
  capabilities: projectCapabilities(readCapabilityRegistry),
} as unknown as CanonicalJson;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${canonicalJsonStringify(output)}\n`, { encoding: "utf8", mode: 0o644 });
