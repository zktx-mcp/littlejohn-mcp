import {fixedIdentifierSchema} from "../../core/client.js";

export interface PresentationTurnContext {
  readonly threadId: ReturnType<typeof fixedIdentifierSchema.parse>;
  readonly turnId: ReturnType<typeof fixedIdentifierSchema.parse>;
}

const ownData = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("Publication context requires an own data property.");
  return descriptor.value as unknown;
};

export const normalizeCodexTurnContext = (metadata: unknown): PresentationTurnContext => {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) throw new TypeError("Publication metadata is unavailable.");
  const carrier = ownData(metadata, "x-codex-turn-metadata");
  if (typeof carrier !== "object" || carrier === null || Array.isArray(carrier)) throw new TypeError("Publication context must be an object.");
  // Provider extras remain unread. The bound applies to this normalized pair, not the decoded MCP frame.
  return Object.freeze({threadId: fixedIdentifierSchema.parse(ownData(carrier, "thread_id")),
    turnId: fixedIdentifierSchema.parse(ownData(carrier, "turn_id"))});
};
