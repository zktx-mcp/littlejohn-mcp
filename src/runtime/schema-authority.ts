import { z } from "zod";

import { captureCanonicalJson } from "../core/index.js";

const rejectedRuntimeJson = Symbol("rejectedRuntimeJson");

const captureRuntimeJson = (input: unknown): unknown => {
  try {
    return captureCanonicalJson(input);
  } catch {
    return rejectedRuntimeJson;
  }
};

export const guardRuntimeJsonSchema = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess(captureRuntimeJson, schema) as z.ZodType<z.output<Schema>, z.input<Schema>>;

export const parseRuntimeAuthority = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> => {
  const captured = captureRuntimeJson(input);
  if (captured === rejectedRuntimeJson) throw new TypeError("Runtime JSON input is invalid.");
  return schema.parse(captured);
};
