import { z } from "zod";
import { closedTupleSchema } from "../core/client.js";

export const walletSessionRequirements = Object.freeze({
  requiredMethods: Object.freeze(["eth_sendTransaction"] as const),
  requiredEvents: Object.freeze(["accountsChanged", "chainChanged"] as const),
});

const literalTuple = <const Values extends readonly [string, ...string[]]>(values: Values) =>
  closedTupleSchema(values.map((value) => z.literal(value)) as {
    readonly [Index in keyof Values]: z.ZodLiteral<Values[Index]>;
  });

export const walletSessionRequirementsSchema = z.object({
  requiredMethods: literalTuple(walletSessionRequirements.requiredMethods),
  requiredEvents: literalTuple(walletSessionRequirements.requiredEvents),
}).strict();
