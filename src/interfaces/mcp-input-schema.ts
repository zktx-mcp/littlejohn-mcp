import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  compareCodePointSequences,
  type CanonicalJson,
} from "../core/index.js";

type JsonRecord = Readonly<Record<string, CanonicalJson>>;

const record = (value: CanonicalJson | undefined): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;

const stringArray = (value: CanonicalJson | undefined): readonly string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;

const sameValue = (left: CanonicalJson, right: CanonicalJson): boolean =>
  canonicalJsonStringify(left) === canonicalJsonStringify(right);

const sortedNames = (values: Iterable<string>): readonly string[] =>
  [...values].sort(compareCodePointSequences);

const uniqueSchemas = (schemas: readonly CanonicalJson[]): readonly CanonicalJson[] => {
  const unique = new Map<string, CanonicalJson>();
  for (const schema of schemas) unique.set(canonicalJsonStringify(schema), schema);
  return [...unique.entries()]
    .sort(([left], [right]) => compareCodePointSequences(left, right))
    .map(([, schema]) => schema);
};

interface ClosedObjectBranch {
  readonly properties: JsonRecord;
  readonly required: ReadonlySet<string>;
}

const closedObjectBranch = (value: CanonicalJson): ClosedObjectBranch | undefined => {
  const source = record(value);
  if (source === undefined) return undefined;
  const keys = Object.keys(source);
  if (keys.some((key) => !["type", "properties", "required", "additionalProperties"].includes(key))) {
    return undefined;
  }
  if (source["type"] !== "object" || source["additionalProperties"] !== false) return undefined;
  const properties = record(source["properties"]);
  const required = stringArray(source["required"]);
  if (
    properties === undefined ||
    required === undefined ||
    new Set(required).size !== required.length ||
    required.some((name) => properties[name] === undefined)
  ) return undefined;
  return Object.freeze({ properties, required: new Set(required) });
};

const literalDiscriminator = (
  branches: readonly ClosedObjectBranch[],
): string | undefined => {
  const commonNames = Object.keys(branches[0]?.properties ?? {}).filter((name) =>
    branches.every((branch) => branch.properties[name] !== undefined),
  );
  const candidates = commonNames.filter((name) => {
    const values = branches.map((branch) => record(branch.properties[name])?.["const"]);
    return values.every((value) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean") &&
      new Set(values.map((value) => canonicalJsonStringify(value as CanonicalJson))).size === branches.length;
  });
  return candidates.length === 1 ? candidates[0] : undefined;
};

const projectedProperty = (
  name: string,
  discriminator: string,
  branches: readonly ClosedObjectBranch[],
): CanonicalJson => {
  const variants = branches.flatMap((branch) => {
    const schema = branch.properties[name];
    return schema === undefined ? [] : [schema];
  });
  if (name === discriminator) {
    const records = variants.map(record);
    if (records.every((value) => value !== undefined)) {
      const withoutConst = records.map((value) => Object.fromEntries(
        Object.entries(value as JsonRecord).filter(([key]) => key !== "const"),
      ));
      if (withoutConst.every((value) => sameValue(value, withoutConst[0] as CanonicalJson))) {
        return captureCanonicalJson({
          ...withoutConst[0],
          enum: variants.map((value) => (value as JsonRecord)["const"]),
        });
      }
    }
  }
  const unique = uniqueSchemas(variants);
  return unique.length === 1
    ? unique[0] as CanonicalJson
    : captureCanonicalJson({ anyOf: unique });
};

const factorClosedObjectUnion = (schema: CanonicalJson): CanonicalJson => {
  const root = record(schema);
  const oneOf = root === undefined ? undefined : root["oneOf"];
  if (!Array.isArray(oneOf) || oneOf.length < 2) return schema;
  if (root === undefined) return schema;
  const permittedRootKeys = new Set(["$schema", "$id", "$defs", "title", "description", "oneOf"]);
  if (Object.keys(root).some((key) => !permittedRootKeys.has(key))) return schema;
  const branches = oneOf.map(closedObjectBranch);
  if (branches.some((branch) => branch === undefined)) return schema;
  const closed = branches as readonly ClosedObjectBranch[];
  const discriminator = literalDiscriminator(closed);
  if (discriminator === undefined) return schema;

  const propertyNames = sortedNames(new Set(closed.flatMap((branch) => Object.keys(branch.properties))));
  const commonRequired = sortedNames(propertyNames.filter((name) =>
    closed.every((branch) => branch.required.has(name)),
  ));
  const properties = Object.fromEntries(propertyNames.map((name) => [
    name,
    projectedProperty(name, discriminator, closed),
  ]));
  const projectedBranches = closed.map((branch) => {
    const branchProperties: Record<string, CanonicalJson> = {
      [discriminator]: branch.properties[discriminator] as CanonicalJson,
    };
    for (const name of propertyNames) {
      if (name === discriminator) continue;
      const branchSchema = branch.properties[name];
      if (
        branchSchema !== undefined &&
        (
          !sameValue(branchSchema, properties[name] as CanonicalJson) ||
          (branch.required.has(name) && !commonRequired.includes(name))
        )
      ) branchProperties[name] = branchSchema;
    }
    const required = sortedNames([...branch.required].filter((name) => !commonRequired.includes(name)));
    const absent = propertyNames.filter((name) => branch.properties[name] === undefined);
    const forbidden = absent.length === 0
      ? undefined
      : absent.length === 1
        ? { properties: { [absent[0] as string]: properties[absent[0] as string] }, required: absent }
        : {
            anyOf: absent.map((name) => ({
              properties: { [name]: properties[name] },
              required: [name],
            })),
          };
    return captureCanonicalJson({
      properties: branchProperties,
      ...(required.length === 0 ? {} : { required }),
      ...(forbidden === undefined ? {} : { not: forbidden }),
    });
  });

  const retainedRoot = Object.fromEntries(
    Object.entries(root).filter(([key]) => key !== "oneOf"),
  );
  return captureCanonicalJson({
    ...retainedRoot,
    type: "object",
    properties,
    required: commonRequired,
    additionalProperties: false,
    oneOf: projectedBranches,
  });
};

/**
 * Keeps the owning parser's accepted value set while expressing a closed
 * top-level discriminated object as one object shape. This is one standard MCP
 * schema projection for every Host; it never repairs or reinterprets input.
 */
export const projectMcpInputSchema = (value: unknown): Tool["inputSchema"] => {
  const captured = captureCanonicalJson(JSON.parse(JSON.stringify(value)) as unknown);
  const projected = factorClosedObjectUnion(captured);
  const root = record(projected);
  if (root === undefined || (root["type"] !== undefined && root["type"] !== "object")) {
    throw new TypeError("MCP input schema must describe an object.");
  }
  return captureCanonicalJson({ ...root, type: "object" }) as Tool["inputSchema"];
};
