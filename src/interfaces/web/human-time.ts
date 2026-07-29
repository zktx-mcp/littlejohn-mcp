import {
  unsignedDecimalSchema,
  utcTimestampSchema,
  type UtcTimestamp,
} from "../../core/browser.js";

const humanUtcText = (instant: UtcTimestamp): string => {
  const milliseconds = instant.slice(19, 23);
  return milliseconds === ".000"
    ? `${instant.slice(0, 10)} ${instant.slice(11, 19)} UTC`
    : `${instant.slice(0, 10)} ${instant.slice(11, 23)} UTC`;
};

export const formatUtcTimestamp = (value: string): string =>
  humanUtcText(utcTimestampSchema.parse(value));

export const formatUnixSecondsAsUtc = (value: string): string => {
  try {
    const seconds = BigInt(unsignedDecimalSchema.parse(value));
    return humanUtcText(
      utcTimestampSchema.parse(new Date(Number(seconds * 1_000n)).toISOString()),
    );
  } catch {
    throw new TypeError("Unix seconds do not identify an admitted UTC instant.");
  }
};
