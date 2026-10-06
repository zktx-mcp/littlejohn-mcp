import { maximumSuccessUtf8Bytes } from "../core/client.js";

export const requestBodyLimitBytes = 65_536;
export const internalResponseLimitBytes = 65_536;
export const internalCanonicalJsonResponseLimitBytes = internalResponseLimitBytes - 1;
export const publicReadResponseLimitBytes = maximumSuccessUtf8Bytes + 1;
export const requestTargetUtf16CodeUnitLimit = 4_096;
export const routePathnameUtf16CodeUnitLimit = 2_048;
export const routePathSegmentAsciiCharacterLimit = 128;
export const ownerTransportDeadlineMilliseconds = 2_000;
export const ownerContentionDeadlineMilliseconds = 2_000;
// The first integer timer delay and geometric backoff define the work bound.
export const ownerRetryMinimumDelayMilliseconds = 1;
export const ownerRetryDelayGrowth = 2;

if (
  !Number.isSafeInteger(internalCanonicalJsonResponseLimitBytes) ||
  internalCanonicalJsonResponseLimitBytes < 1
) throw new TypeError("Internal canonical JSON response limit is invalid.");
