import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  canonicalBase64UrlSchema,
  canonicalJsonStringify,
  captureCanonicalJson,
  compareCodePointSequences,
  decodeCanonicalBase64Url,
  evmAddressSchema,
  evmAddressInputSchema,
  evmAccountIdentitySchema,
  evmChainIdSchema,
  evmContractIdentitySchema,
  deriveCaip10Account,
  parseCaip10EvmAccount,
  parseEvmAccountIdentity,
  parseEvmAddressInput,
  parseEvmContractIdentity,
  hexBytesSchema,
  isSafeSingleLineText,
  isWellFormedText,
  unsignedDecimalSchema,
  utcTimestampSchema,
  chainAnchorSchema,
} from "../../src/core/index.js";

describe("canonical primitives", () => {
  it("accepts only canonical unsigned decimal strings", () => {
    for (const value of ["0", "1", "9007199254740993"]) expect(unsignedDecimalSchema.safeParse(value).success).toBe(true);
    for (const value of ["", "00", "01", "+1", "-1", "1.0", "1e2", 1]) {
      expect(unsignedDecimalSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects non-canonical EVM and byte encodings", () => {
    expect(evmAddressSchema.safeParse(`0x${"a".repeat(40)}`).success).toBe(true);
    expect(evmAddressSchema.safeParse(`0x${"A".repeat(40)}`).success).toBe(false);
    expect(hexBytesSchema.safeParse("0x").success).toBe(true);
    expect(hexBytesSchema.safeParse("0x0").success).toBe(false);
    expect(hexBytesSchema.safeParse("0xAA").success).toBe(false);
  });

  it("accepts canonical EIP-155 chain identities only", () => {
    for (const value of ["eip155:1", "eip155:4663", `eip155:${"9".repeat(32)}`]) {
      expect(evmChainIdSchema.safeParse(value).success).toBe(true);
    }
    for (const value of ["eip155:0", "eip155:01", "eip155:0x1", "EIP155:1", "1", `eip155:${"9".repeat(33)}`, "eip155:1\0suffix"]) {
      expect(evmChainIdSchema.safeParse(value).success).toBe(false);
    }
  });

  it("normalizes external EVM addresses and verifies EIP-55 mixed case", () => {
    const official = [
      "0x52908400098527886E0F7030069857D2E4169EE7",
      "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
      "0xde709f2102306220921060314715629080e2fb77",
      "0x27b1fdb04752bbc536007a920d24acb045561c26",
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ];
    for (const value of official) {
      expect(parseEvmAddressInput(value)).toBe(value.toLowerCase());
    }
    expect(parseEvmAddressInput(`0x${"A".repeat(40)}`)).toBe(`0x${"a".repeat(40)}`);
    for (const value of [
      "0x52908400098527886e0F7030069857D2E4169EE7",
      `0X${"1".repeat(40)}`,
      `0x${"1".repeat(39)}`,
      `0x${"g".repeat(40)}`,
      `0x${"1".repeat(40)}\0`,
    ]) expect(evmAddressInputSchema.safeParse(value).success).toBe(false);
  });

  it("derives CAIP-10 account text from one chain-address identity", () => {
    const identity = {
      chainId: evmChainIdSchema.parse("eip155:4663"),
      address: evmAddressSchema.parse(`0x${"1".repeat(40)}`),
    };
    const account = deriveCaip10Account(identity);
    expect(account).toBe(`eip155:4663:0x${"1".repeat(40)}`);
    expect(parseCaip10EvmAccount(account)).toEqual(identity);
    expect(parseCaip10EvmAccount(`eip155:1:0x${"1".repeat(40)}`)).not.toEqual(identity);
    for (const value of [
      `eip155:01:0x${"1".repeat(40)}`,
      `eip155:1:extra:0x${"1".repeat(40)}`,
      `eip155:1:0X${"1".repeat(40)}`,
      `eip155:1:0x${"1".repeat(39)}`,
    ]) expect(() => parseCaip10EvmAccount(value)).toThrow("CAIP-10");
    expect(evmContractIdentitySchema.parse({
      chainId: "eip155:4663",
      contractAddress: identity.address,
    })).toEqual({ chainId: identity.chainId, contractAddress: identity.address });
  });

  it("guards public EVM identity object schemas against hostile own keys", () => {
    const identity = {
      chainId: "eip155:4663",
      address: `0x${"1".repeat(40)}`,
    };
    const hostile = Object.defineProperty({ ...identity }, "__proto__", {
      value: undefined,
      enumerable: true,
    });
    expect(evmAccountIdentitySchema.safeParse(hostile).success).toBe(false);

    let getterReads = 0;
    const getterBacked = {
      address: identity.address,
    } as { address: string; chainId?: string };
    Object.defineProperty(getterBacked, "chainId", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("secret identity getter");
      },
    });
    expect(() => parseEvmAccountIdentity(getterBacked)).toThrow();
    expect(() => deriveCaip10Account(getterBacked as never)).toThrow();
    expect(getterReads).toBe(0);

    const inheritedFields = Object.create(Object.defineProperties({}, {
      ["__proto__"]: { value: undefined },
      chainId: { value: identity.chainId, enumerable: true },
    })) as { address: string };
    inheritedFields.address = identity.address;
    expect(evmAccountIdentitySchema.safeParse(inheritedFields).success).toBe(false);
    expect(() => parseEvmAccountIdentity(inheritedFields)).toThrow();

    let contractGetterReads = 0;
    const hostileContract = { chainId: identity.chainId } as { chainId: string; contractAddress?: string };
    Object.defineProperty(hostileContract, "contractAddress", {
      enumerable: true,
      get() {
        contractGetterReads += 1;
        throw new Error("secret contract getter");
      },
    });
    expect(() => parseEvmContractIdentity(hostileContract)).toThrow();
    expect(contractGetterReads).toBe(0);
  });

  it("rejects an own prototype key through direct public schema use", () => {
    const anchor = {
      chainId: "eip155:4663",
      blockNumber: "1",
      blockHash: `0x${"a".repeat(64)}`,
      blockTimestamp: "2026-07-12T10:16:02.000Z",
    };
    for (const value of [undefined, Object.prototype]) {
      const candidate = Object.defineProperty({ ...anchor }, "__proto__", {
        value,
        enumerable: true,
      });
      expect(chainAnchorSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("accepts only canonical unpadded base64url for the declared byte length", () => {
    const bytes = Buffer.alloc(32, 1);
    const canonical = bytes.toString("base64url");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(canonical.at(-1) as string);
    const alternate = `${canonical.slice(0, -1)}${alphabet[(last + 1) % alphabet.length]}`;
    expect(Buffer.from(alternate, "base64url").equals(bytes)).toBe(true);
    expect(canonicalBase64UrlSchema(32).safeParse(canonical).success).toBe(true);
    expect(canonicalBase64UrlSchema(32).safeParse(alternate).success).toBe(false);
    expect(() => decodeCanonicalBase64Url(alternate, 32)).toThrow("canonical");
  });

  it("round-trips canonical base64url bytes through the single parser", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (bytes) => {
      const encoded = Buffer.from(bytes).toString("base64url");
      expect(decodeCanonicalBase64Url(encoded, 16)).toEqual(bytes);
    }));
  });

  it("requires real UTC timestamps with exact millisecond precision", () => {
    expect(utcTimestampSchema.safeParse("2026-07-12T10:16:02.000Z").success).toBe(true);
    expect(utcTimestampSchema.safeParse("2000-02-29T23:59:59.999Z").success).toBe(true);
    for (const value of [
      "2026-07-12T10:16:02Z",
      "2026-07-12T10:16:02.00Z",
      "2026-07-12T10:16:02.000+00:00",
      "2026-02-30T10:16:02.000Z",
      "1900-02-29T10:16:02.000Z",
      "2026-07-12T24:00:00.000Z",
      "2026-07-12T23:60:00.000Z",
      "2026-07-12T23:59:60.000Z",
    ]) expect(utcTimestampSchema.safeParse(value).success).toBe(false);
  });

  it("orders Unicode by code-point sequence", () => {
    const values = ["", "a", "aa", "\u{10000}", "\uffff", "\ud800", "\udfff", "😀", "😀a"];
    const reference = (left: string, right: string): number => {
      const a = Array.from(left, (character) => character.codePointAt(0) as number);
      const b = Array.from(right, (character) => character.codePointAt(0) as number);
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) return (a[index] as number) < (b[index] as number) ? -1 : 1;
      }
      return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
    };
    for (const left of values) {
      for (const right of values) {
        expect(compareCodePointSequences(left, right)).toBe(reference(left, right));
      }
    }
  });

  it("matches an independent code-point comparator for generated strings", () => {
    const reference = (left: string, right: string): number => {
      const a = Array.from(left, (character) => character.codePointAt(0) as number);
      const b = Array.from(right, (character) => character.codePointAt(0) as number);
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) return (a[index] as number) < (b[index] as number) ? -1 : 1;
      }
      return Math.sign(a.length - b.length);
    };
    fc.assert(fc.property(fc.string(), fc.string(), (left, right) => {
      expect(compareCodePointSequences(left, right)).toBe(reference(left, right));
    }));
  });

  it("rejects every declared unsafe single-line range", () => {
    const ranges = [[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x202e], [0x2066, 0x2069]] as const;
    for (const [first, last] of ranges) {
      for (let codePoint = first; codePoint <= last; codePoint += 1) {
        expect(isSafeSingleLineText(`safe${String.fromCodePoint(codePoint)}text`)).toBe(false);
      }
    }
    expect(isSafeSingleLineText("safe text 😀")).toBe(true);
  });

  it("rejects ill-formed Unicode before canonical text and JSON encoding", () => {
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdfff);
    expect(isWellFormedText(high)).toBe(false);
    expect(isWellFormedText(low)).toBe(false);
    expect(isSafeSingleLineText(`safe${high}text`)).toBe(false);
    expect(() => canonicalJsonStringify({ value: high })).toThrow("ill-formed Unicode");
    expect(() => canonicalJsonStringify({ [low]: "value" })).toThrow("ill-formed Unicode keys");
    expect(canonicalJsonStringify({ value: "safe text 😀" })).toBe('{"value":"safe text 😀"}');
  });

  it("canonicalizes key order independently of insertion order", () => {
    expect(canonicalJsonStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJsonStringify({ "2": 2, "10": 1 })).toBe('{"10":1,"2":2}');
    expect(canonicalJsonStringify({ "\uffff": 1, "\u{10000}": 2 })).toBe('{"￿":1,"𐀀":2}');
  });

  it("rejects accessor-backed canonical JSON without invoking the getter", () => {
    let invoked = false;
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("secret-provider-payload");
      },
    });
    expect(() => canonicalJsonStringify(value as never)).toThrow("accessors");
    expect(invoked).toBe(false);
  });

  it("rejects sparse, accessor-backed, and extended arrays", () => {
    const sparse = new Array<unknown>(1);
    expect(() => canonicalJsonStringify(sparse as never)).toThrow("sparse");

    let invoked = false;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return "secret";
      },
    });
    Object.defineProperty(accessor, "length", { value: 1 });
    expect(() => canonicalJsonStringify(accessor as never)).toThrow("accessor-backed");
    expect(invoked).toBe(false);

    const extended = [1] as number[] & { label?: string };
    extended.label = "extra";
    expect(() => canonicalJsonStringify(extended as never)).toThrow("additional array properties");
  });

  it("uses one descriptor snapshot for canonical capture and serialization", () => {
    let ownKeyReads = 0;
    const value = new Proxy({ visible: 1 }, {
      ownKeys() {
        ownKeyReads += 1;
        return ownKeyReads === 1 ? ["visible"] : [];
      },
      getOwnPropertyDescriptor(_target, key) {
        if (key === "visible") return { configurable: true, enumerable: true, writable: true, value: 1 };
        return undefined;
      },
    });
    expect(canonicalJsonStringify(value as never)).toBe('{"visible":1}');
    expect(ownKeyReads).toBe(1);
    expect(captureCanonicalJson({ b: 2, a: 1 })).toEqual({ a: 1, b: 2 });
  });

  it("applies the same nesting boundary to capture and serialization", () => {
    let value: unknown = null;
    for (let index = 0; index < 66; index += 1) value = { nested: value };
    expect(() => captureCanonicalJson(value)).toThrow("nesting");
    expect(() => canonicalJsonStringify(value as never)).toThrow("nesting");
  });
});
