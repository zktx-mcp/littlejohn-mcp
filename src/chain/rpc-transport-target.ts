import { rpcTransportTargetByteLimit } from "./limits.js";

const rawControlPattern = /[\u0000-\u001f\u007f]/u;
const rpcUrlErrorMessage = "RPC URL is invalid.";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface RpcTransportTarget {
  readonly exactUri: string;
  readonly exactUtf8: Uint8Array;
  readonly publicOrigin: string;
  readonly fetchUrl: string;
  readonly authorization?: string;
}

const invalidRpcUrl = (): never => {
  throw new TypeError(rpcUrlErrorMessage);
};

const decodeUserInformation = (value: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalidRpcUrl();
  }
  if (rawControlPattern.test(decoded)) return invalidRpcUrl();
  return decoded;
};

export const admitRpcTransportTarget = (input: unknown): RpcTransportTarget => {
  if (typeof input !== "string") return invalidRpcUrl();
  const exactUtf8 = utf8Encoder.encode(input);
  if (
    exactUtf8.length === 0 ||
    exactUtf8.length > rpcTransportTargetByteLimit ||
    utf8Decoder.decode(exactUtf8) !== input ||
    input.includes("#") ||
    rawControlPattern.test(input)
  ) return invalidRpcUrl();

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return invalidRpcUrl();
  }
  if (url.protocol !== "https:") return invalidRpcUrl();

  let authorization: string | undefined;
  if (url.username !== "" || url.password !== "") {
    const username = decodeUserInformation(url.username);
    const password = decodeUserInformation(url.password);
    if (username.includes(":")) return invalidRpcUrl();
    authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  }

  url.username = "";
  url.password = "";
  const target = {
    exactUri: input,
    exactUtf8: new Uint8Array(exactUtf8),
    publicOrigin: url.origin,
    fetchUrl: url.href,
    ...(authorization === undefined ? {} : { authorization }),
  } satisfies RpcTransportTarget;
  return Object.freeze(target);
};
