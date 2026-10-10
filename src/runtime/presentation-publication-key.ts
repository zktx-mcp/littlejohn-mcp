import {createHmac} from "node:crypto";
import {canonicalJsonStringify, canonicalBase64UrlSchema} from "../core/index.js";
import {fixedIdentifierSchema} from "../core/index.js";
import {parseProfileId, type ProfileId} from "./runtime-identity.js";
import type {PresentationTurnContext} from "../interfaces/mcp-app/publication-context.js";
import {deriveControlCredentialKey, type LocalControlCredentialAuthority} from "./control-credential.js";

export const presentationPublicationKeySchema = canonicalBase64UrlSchema(32);
export interface PresentationPublicationKeyOwner {
  derive(context: PresentationTurnContext): string;
}
export const createPresentationPublicationKeyOwner = (input: Readonly<{credential: LocalControlCredentialAuthority; profileId: ProfileId}>): PresentationPublicationKeyOwner => {
  const key = deriveControlCredentialKey(input.credential, "littlejohn/presentation-publication/v1");
  const profileId = parseProfileId(input.profileId);
  return Object.freeze({derive(context: PresentationTurnContext): string {
    const pair = {threadId: fixedIdentifierSchema.parse(context.threadId), turnId: fixedIdentifierSchema.parse(context.turnId)};
    return presentationPublicationKeySchema.parse(createHmac("sha256", key).update(canonicalJsonStringify({profileId, ...pair})).digest("base64url"));
  }});
};
