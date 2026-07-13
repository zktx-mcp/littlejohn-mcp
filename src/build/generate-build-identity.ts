import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonStringify, type CanonicalJson } from "../core/index.js";
import { createRuntimeBuildIdentityFromFiles } from "./runtime-file-set.js";

const distDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(distDirectory, "..");
const outputPath = resolve(distDirectory, "generated/runtime-build-identity.json");

const identity = await createRuntimeBuildIdentityFromFiles(repositoryRoot, distDirectory, outputPath);
await writeFile(outputPath, `${canonicalJsonStringify(identity as unknown as CanonicalJson)}\n`, { encoding: "utf8", mode: 0o644 });
