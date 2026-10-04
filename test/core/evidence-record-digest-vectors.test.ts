import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  createEvidenceFactIdentityDeclaration,
  createEvidenceObservationTargetDeclaration,
  createEvidenceReplayBinder,
  createEvidenceReplayLayout,
  createExactConclusionIdentityDeclaration,
  type CanonicalJson,
} from "../../src/core/client.js";
import { createEvidenceSourceRecordDigest } from "../../src/core/evidence-replay.js";
import { assetIdentitySchema } from "../../src/evm/amounts.js";
import { evidenceSourceRecordSchema } from "../../src/evm/evidence.js";
import { createEvmEvidenceReplayDefinition } from "../../src/evm/evidence-replay.js";
import { chainAnchorSchema } from "../../src/evm/primitives.js";

const primitiveInput =
  `{"claims":[{"role":"chain_id","value":"eip155:4663"}],"digestKind":"evidence_source_record","source":{"invocationId":"inv:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc","observationId":"obs:KjVdvtRZIJy3zwHA7Otc5wCEv_RCinW1N7dbJRfdlhU","observedAt":"2026-07-26T00:00:00.000Z","owner":"Little John validated input","purpose":"validated_input","reference":{"kind":"validated_input","sourceId":"input:test.vector"},"sourceClass":"validated_input"}}`;
const nestedInput =
  `{"claims":[{"asset":{"address":"0x1111111111111111111111111111111111111111","chainId":"eip155:4663","kind":"erc20"},"chainAnchor":{"blockHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","blockNumber":"42","blockTimestamp":"2026-07-26T00:00:00.000Z","chainId":"eip155:4663"},"role":"token_balance","value":{"raw":"123456789","source":{"kind":"rpc","valid":true}}},{"role":"token_metadata","value":{"name":"Example","tags":["stock","verified"]}}],"digestKind":"evidence_source_record","source":{"chainAnchor":{"blockHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","blockNumber":"42","blockTimestamp":"2026-07-26T00:00:00.000Z","chainId":"eip155:4663"},"invocationId":"inv:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc","observationId":"obs:KjVdvtRZIJy3zwHA7Otc5wCEv_RCinW1N7dbJRfdlhU","observedAt":"2026-07-26T00:00:00.000Z","owner":"user_configured","purpose":"token_balance","reference":{"configurationDigest":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI","kind":"configured_rpc","publicOrigin":"https://rpc.example","sourceId":"rpc:AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI"},"sourceClass":"chain_rpc"}}`;

const sha256Base64Url = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("base64url");

const productRecordDigest = (input: string): string => {
  const vector = JSON.parse(input) as {
    source: unknown;
    claims: readonly { role: string; value: CanonicalJson; asset?: unknown; chainAnchor?: unknown }[];
  };
  const source = evidenceSourceRecordSchema.parse(vector.source);
  const definition = createEvmEvidenceReplayDefinition({
    capabilityId: "test.vector",
    conclusions: [createExactConclusionIdentityDeclaration("record_validated")],
    warningCodes: [],
  });
  const fact = createEvidenceFactIdentityDeclaration(definition, "record");
  const roles: Readonly<Record<string, string>> = source.sourceClass === "validated_input"
    ? { chain_id: "chain_id" }
    : { token_balance: "token_balance", token_metadata: "token_metadata" };
  const target = createEvidenceObservationTargetDeclaration(definition, {
    slotId: "record", fact, purpose: source.purpose,
    roles,
    ...(source.sourceClass === "validated_input"
      ? { kind: "validated_input" as const, owner: source.owner, sourceId: source.reference.sourceId }
      : { kind: "source" as const, sourceClass: source.sourceClass }),
  });
  const layout = createEvidenceReplayLayout(definition, [target]);
  const bound = createEvidenceReplayBinder(definition, layout).bind(target);
  const claims = vector.claims.map((claim) => {
    const role = bound.roles[claim.role];
    if (role === undefined) throw new TypeError("Digest vector role is unavailable.");
    return {
      role, value: claim.value,
      ...(claim.asset === undefined ? {} : { asset: assetIdentitySchema.parse(claim.asset) }),
      ...(claim.chainAnchor === undefined ? {} : { chainAnchor: chainAnchorSchema.parse(claim.chainAnchor) }),
    };
  });
  return createEvidenceSourceRecordDigest(definition, layout, bound.slot, source, claims);
};

describe("public evidence record digest vectors", () => {
  it("fixes the primitive canonical input independently from production code", () => {
    expect(Buffer.byteLength(primitiveInput, "utf8")).toBe(442);
    expect(sha256Base64Url(primitiveInput))
      .toBe("ZmD5wW_YEPx-OdRffN6yiNeHk4VQjtR6KMTdMURvGbc");
    expect(productRecordDigest(primitiveInput))
      .toBe("ZmD5wW_YEPx-OdRffN6yiNeHk4VQjtR6KMTdMURvGbc");
    expect(sha256Base64Url(primitiveInput.replace("4663", "4664")))
      .not.toBe("ZmD5wW_YEPx-OdRffN6yiNeHk4VQjtR6KMTdMURvGbc");
    expect(productRecordDigest(primitiveInput.replace("4663", "4664")))
      .not.toBe("ZmD5wW_YEPx-OdRffN6yiNeHk4VQjtR6KMTdMURvGbc");
  });

  it("fixes the nested canonical input independently from production code", () => {
    expect(Buffer.byteLength(nestedInput, "utf8")).toBe(1_157);
    expect(sha256Base64Url(nestedInput))
      .toBe("Z0F1G4UTt8qDX69FzgOTaOAwL3PRkIpj0_cv2xcvoWI");
    expect(productRecordDigest(nestedInput))
      .toBe("Z0F1G4UTt8qDX69FzgOTaOAwL3PRkIpj0_cv2xcvoWI");
    expect(sha256Base64Url(nestedInput.replace("123456789", "123456790")))
      .not.toBe("Z0F1G4UTt8qDX69FzgOTaOAwL3PRkIpj0_cv2xcvoWI");
    expect(productRecordDigest(nestedInput.replace("123456789", "123456790")))
      .not.toBe("Z0F1G4UTt8qDX69FzgOTaOAwL3PRkIpj0_cv2xcvoWI");
  });
});
