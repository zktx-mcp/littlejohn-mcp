import { z, type ZodRawShape } from "zod";

const rejectedJsonObject = Symbol("rejectedJsonObject");

const hasSafePrototypeKeys = (input: unknown): boolean => {
  const active = new WeakSet<object>();
  const verified = new WeakSet<object>();
  const stack: { readonly value: unknown; readonly exit: boolean }[] = [{ value: input, exit: false }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined || typeof entry.value !== "object" || entry.value === null) continue;
    if (entry.exit) {
      active.delete(entry.value);
      verified.add(entry.value);
      continue;
    }
    if (verified.has(entry.value)) continue;
    if (active.has(entry.value)) return false;
    let descriptors: Record<PropertyKey, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(entry.value) as Record<PropertyKey, PropertyDescriptor>;
    } catch {
      return false;
    }
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol" || key === "__proto__")) return false;
    active.add(entry.value);
    stack.push({ value: entry.value, exit: true });
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return false;
      stack.push({ value: descriptor.value, exit: false });
    }
  }
  return true;
};

export const guardJsonSchema = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((input) => hasSafePrototypeKeys(input) ? input : rejectedJsonObject, schema) as z.ZodType<
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
