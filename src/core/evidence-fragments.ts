import { createExactConclusionIdentityDeclaration, type ExactConclusionIdentityDeclaration } from "./evidence-replay.js";
import { staticScopeExclusionSchema, type StaticScopeExclusion } from "./evidence.js";

export const exclusion = (id: string, message: string): StaticScopeExclusion =>
  Object.freeze(staticScopeExclusionSchema.parse({ id, message })) as StaticScopeExclusion;

export const exactConclusion = (identity: string): ExactConclusionIdentityDeclaration =>
  createExactConclusionIdentityDeclaration(identity);
