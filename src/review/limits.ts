export const exchangeLimits = Object.freeze({
  reviewUtf8Bytes: 32_768,
  privateRequestUtf8Bytes: 4_096,
  liveReviews: 16,
  reviewLifetimeMilliseconds: 300_000,
  grantLifetimeMilliseconds: 5_000,
} as const);
