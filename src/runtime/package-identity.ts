import { readFileSync } from "node:fs";
import { fixedIdentifierSchema } from "../core/client.js";

const readPackageIdentity = () => {
  const value: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("The package identity is invalid.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  return Object.freeze({
    name: fixedIdentifierSchema.parse(record["name"]),
    version: fixedIdentifierSchema.parse(record["version"]),
  });
};

export const runtimePackageIdentity = readPackageIdentity();
