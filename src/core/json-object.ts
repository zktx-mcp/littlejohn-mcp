import { z, type ZodRawShape } from "zod";

const rejectedJsonObject = Symbol("rejectedJsonObject");
const maximumJsonDepth = 64;
const maximumJsonArrayLength = 8_192;

const captureJsonInput = (input: unknown, active: WeakSet<object>, depth: number): unknown => {
  if (depth > maximumJsonDepth) throw new TypeError("JSON input nesting is excessive.");
  if (typeof input !== "object" || input === null) return input;
  if (active.has(input)) throw new TypeError("JSON input cannot contain a cycle.");
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input) as Record<PropertyKey, PropertyDescriptor>;
  } catch {
    throw new TypeError("JSON input cannot be inspected safely.");
  }
  active.add(input);
  try {
    if (Array.isArray(input)) {
      const lengthDescriptor = descriptors["length"];
      const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
        ? lengthDescriptor.value as unknown
        : undefined;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > maximumJsonArrayLength
      ) throw new TypeError("JSON array length is invalid.");
      const permitted = new Set<PropertyKey>(["length"]);
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        permitted.add(key);
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) throw new TypeError("JSON arrays require enumerable data elements.");
        output.push(captureJsonInput(descriptor.value, active, depth + 1));
      }
      if (Reflect.ownKeys(descriptors).some((key) => !permitted.has(key))) {
        throw new TypeError("JSON arrays cannot contain additional properties.");
      }
      return output;
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || key === "__proto__") {
        throw new TypeError("JSON objects require safe string keys.");
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) throw new TypeError("JSON objects require enumerable data fields.");
      output[key] = captureJsonInput(descriptor.value, active, depth + 1);
    }
    return output;
  } finally {
    active.delete(input);
  }
};

export const guardJsonSchema = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((input) => {
    try {
      return captureJsonInput(input, new WeakSet<object>(), 0);
    } catch {
      return rejectedJsonObject;
    }
  }, schema) as z.ZodType<
    z.output<Schema>,
    z.input<Schema>
  >;

const inheritedPrototypeOnly = z.any()
  .refine(
    (value) => value === Object.prototype || value === undefined,
    "JSON objects cannot contain an own __proto__ field.",
  )
  .optional();

export const jsonObject = <const Shape extends ZodRawShape>(shape: Shape) => {
  if (Object.hasOwn(shape, "__proto__")) {
    throw new TypeError("JSON object shapes cannot declare the reserved prototype key.");
  }
  return z.object({
    ...shape,
    ["__proto__"]: inheritedPrototypeOnly,
  }) as unknown as z.ZodObject<Shape>;
};
