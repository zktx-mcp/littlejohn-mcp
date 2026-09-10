import { admitSigningCompletion, type SigningResponseContext } from "../review/signing-contracts.js";

export const signingSignatureMetadataKey = "littlejohn/signature" as const;
export const admitSigningPrivateResult = (context: SigningResponseContext, outcome: unknown, metadata: unknown) => {
  if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) throw new TypeError("Invalid signature carrier.");
  const descriptor = metadata === undefined ? undefined : Object.getOwnPropertyDescriptor(metadata, signingSignatureMetadataKey);
  if (descriptor !== undefined && !("value" in descriptor)) throw new TypeError("Invalid signature carrier.");
  return admitSigningCompletion(context, { outcome, ...(descriptor === undefined ? {} : { signature: descriptor.value }) });
};
