import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

const primitiveInput =
  `{"claims":[{"role":"chain_id","value":"eip155:4663"}],"digestKind":"evidence_source_claims"}`;
const nestedInput =
  `{"claims":[{"asset":{"address":"0x1111111111111111111111111111111111111111","chainId":"eip155:4663","kind":"erc20"},"chainAnchor":{"blockHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","blockNumber":"42","blockTimestamp":"2026-07-26T00:00:00.000Z","chainId":"eip155:4663"},"role":"token_balance","value":{"raw":"123456789","source":{"kind":"rpc","valid":true}}},{"role":"token_metadata","value":{"name":"Example","tags":["stock","verified"]}}],"digestKind":"evidence_source_claims"}`;

const sha256Base64Url = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("base64url");

describe("public evidence claim digest vectors", () => {
  it("fixes the primitive canonical input independently from production code", () => {
    expect(Buffer.byteLength(primitiveInput, "utf8")).toBe(92);
    expect(sha256Base64Url(primitiveInput))
      .toBe("jxlez_R4lwimoz7QofFJLou8ECkYQi4P7Ic9RKdgu_Q");
    expect(sha256Base64Url(primitiveInput.replace("4663", "4664")))
      .not.toBe("jxlez_R4lwimoz7QofFJLou8ECkYQi4P7Ic9RKdgu_Q");
  });

  it("fixes the nested canonical input independently from production code", () => {
    expect(Buffer.byteLength(nestedInput, "utf8")).toBe(509);
    expect(sha256Base64Url(nestedInput))
      .toBe("IP2urjh-5Mw_PmkOwt_2B8zy-4ftiiiXq5ikfQ8xXpo");
    expect(sha256Base64Url(nestedInput.replace("123456789", "123456790")))
      .not.toBe("IP2urjh-5Mw_PmkOwt_2B8zy-4ftiiiXq5ikfQ8xXpo");
  });
});
