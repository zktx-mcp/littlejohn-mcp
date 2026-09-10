import { z } from "zod";
import { closedTupleSchema } from "../core/client.js";

export const walletSigningMethods = Object.freeze({ personal: "personal_sign", typed_data: "eth_signTypedData_v4" } as const);
export const walletSessionRequirements = Object.freeze({
  requiredMethods: Object.freeze(["eth_sendTransaction"] as const),
  optionalMethods: Object.freeze([walletSigningMethods.personal, walletSigningMethods.typed_data] as const),
  requiredEvents: Object.freeze(["accountsChanged", "chainChanged"] as const),
});

const literalTuple = <const Values extends readonly [string, ...string[]]>(values: Values) =>
  closedTupleSchema(values.map((value) => z.literal(value)) as {
    readonly [Index in keyof Values]: z.ZodLiteral<Values[Index]>;
  });

export const walletSessionRequirementsSchema = z.object({
  requiredMethods: literalTuple(walletSessionRequirements.requiredMethods),
  optionalMethods: literalTuple(walletSessionRequirements.optionalMethods),
  requiredEvents: literalTuple(walletSessionRequirements.requiredEvents),
}).strict();
