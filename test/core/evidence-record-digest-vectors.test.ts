import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

const primitiveInput =
  `{"claims":[{"role":"chain_id","value":"eip155:4663"}],"digestKind":"evidence_source_record","source":{"invocationId":"inv:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc","observationId":"obs:KjVdvtRZIJy3zwHA7Otc5wCEv_RCinW1N7dbJRfdlhU","observedAt":"2026-07-26T00:00:00.000Z","owner":"Little John validated input","purpose":"validated_input","reference":{"kind":"validated_input","sourceId":"input:test.vector"},"sourceClass":"validated_input"}}`;
const nestedInput =
  `{"claims":[{"asset":{"address":"0x1111111111111111111111111111111111111111","chainId":"eip155:4663","kind":"erc20"},"chainAnchor":{"blockHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","blockNumber":"42","blockTimestamp":"2026-07-26T00:00:00.000Z","chainId":"eip155:4663"},"role":"token_balance","value":{"raw":"123456789","source":{"kind":"rpc","valid":true}}},{"role":"token_metadata","value":{"name":"Example","tags":["stock","verified"]}}],"digestKind":"evidence_source_record","source":{"chainAnchor":{"blockHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","blockNumber":"42","blockTimestamp":"2026-07-26T00:00:00.000Z","chainId":"eip155:4663"},"invocationId":"inv:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc","observationId":"obs:KjVdvtRZIJy3zwHA7Otc5wCEv_RCinW1N7dbJRfdlhU","observedAt":"2026-07-26T00:00:00.000Z","owner":"user_configured","purpose":"token_balance","reference":{"configurationDigest":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI","kind":"configured_rpc","publicOrigin":"https://rpc.example","sourceId":"rpc:AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI"},"sourceClass":"chain_rpc"}}`;

const sha256Base64Url = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("base64url");

describe("public evidence record digest vectors", () => {
  it("fixes the primitive canonical input independently from production code", () => {
    expect(Buffer.byteLength(primitiveInput, "utf8")).toBe(442);
    expect(sha256Base64Url(primitiveInput))
      .toBe("ZmD5wW_YEPx-OdRffN6yiNeHk4VQjtR6KMTdMURvGbc");
    expect(sha256Base64Url(primitiveInput.replace("4663", "4664")))
      .not.toBe("ZmD5wW_YEPx-OdRffN6yiNeHk4VQjtR6KMTdMURvGbc");
  });

  it("fixes the nested canonical input independently from production code", () => {
    expect(Buffer.byteLength(nestedInput, "utf8")).toBe(1_157);
    expect(sha256Base64Url(nestedInput))
      .toBe("Z0F1G4UTt8qDX69FzgOTaOAwL3PRkIpj0_cv2xcvoWI");
    expect(sha256Base64Url(nestedInput.replace("123456789", "123456790")))
      .not.toBe("Z0F1G4UTt8qDX69FzgOTaOAwL3PRkIpj0_cv2xcvoWI");
  });
});
