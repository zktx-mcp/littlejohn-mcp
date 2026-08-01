import { describe, expect, it } from "vitest";

import { admitRpcTransportTarget } from "../../src/chain/rpc-transport-target.js";

const baseUrl = "https://rpc.example/";
const exactByteLimitUrl = `${baseUrl}${"a".repeat(4_096 - Buffer.byteLength(baseUrl))}`;

describe("RPC transport target admission", () => {
  it("preserves exact HTTPS identity while projecting one credential-free request target", () => {
    const exactUri = "https://us%C3%A9r:p%C3%A4ss%3Aword@rpc.example/%23?key=%ZZ";
    const target = admitRpcTransportTarget(exactUri);

    expect(target).toEqual({
      exactUri,
      exactUtf8: new TextEncoder().encode(exactUri),
      publicOrigin: "https://rpc.example",
      fetchUrl: "https://rpc.example/%23?key=%ZZ",
      authorization: `Basic ${Buffer.from("usér:päss:word", "utf8").toString("base64")}`,
    });
    expect(Object.isFrozen(target)).toBe(true);
  });

  it("accepts the exact byte limit and an encoded fragment as path data", () => {
    const target = admitRpcTransportTarget(exactByteLimitUrl);
    expect(target.exactUtf8).toHaveLength(4_096);
    expect(target.fetchUrl).toBe(exactByteLimitUrl);
    expect(target).not.toHaveProperty("authorization");
  });

  it.each([
    ["username only", "https://user@rpc.example/", "user:"],
    ["password only", "https://:password@rpc.example/", ":password"],
  ] as const)("preserves %s Basic authentication", (_name, exactUri, credentials) => {
    const target = admitRpcTransportTarget(exactUri);
    expect(target.fetchUrl).toBe(baseUrl);
    expect(target.authorization)
      .toBe(`Basic ${Buffer.from(credentials, "utf8").toString("base64")}`);
  });

  it.each([
    ["non-string", null],
    ["empty", ""],
    ["relative", "/rpc"],
    ["plaintext HTTP", "http://rpc.example/"],
    ["another protocol", "ftp://rpc.example/"],
    ["literal fragment", "https://rpc.example/#"],
    ["nonempty literal fragment", "https://rpc.example/#secret"],
    ["raw NUL", "https://rpc.example/\u0000"],
    ["raw tab", "https://rpc.example/\t"],
    ["raw DEL", "https://rpc.example/\u007f"],
    ["unpaired surrogate", "https://rpc.example/\uD800"],
    ["over byte limit", `${exactByteLimitUrl}a`],
    ["malformed username encoding", "https://user%ZZ:password@rpc.example/"],
    ["malformed password encoding", "https://user:%E0%A4%A@rpc.example/"],
    ["colon in decoded username", "https://user%3Aname:password@rpc.example/"],
    ["control in decoded username", "https://user%00:password@rpc.example/"],
    ["control in decoded password", "https://user:password%7F@rpc.example/"],
  ] as const)("rejects %s without exposing the supplied value", (_name, input) => {
    let thrown: unknown;
    try {
      admitRpcTransportTarget(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ message: "RPC URL is invalid." });
    expect(thrown).not.toHaveProperty("cause");
  });

  it("treats syntactically empty user information as credential-free exact identity", () => {
    const withUsernameMarker = admitRpcTransportTarget("https://@rpc.example/");
    const withPasswordMarker = admitRpcTransportTarget("https://:@rpc.example/");

    expect(withUsernameMarker.fetchUrl).toBe(baseUrl);
    expect(withPasswordMarker.fetchUrl).toBe(baseUrl);
    expect(withUsernameMarker).not.toHaveProperty("authorization");
    expect(withPasswordMarker).not.toHaveProperty("authorization");
    expect(withUsernameMarker.exactUri).not.toBe(withPasswordMarker.exactUri);
  });
});
