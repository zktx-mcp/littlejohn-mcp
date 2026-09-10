// Existing one-time Review envelopes, shared by all actual request consumers.
export const requestReviewLimits = Object.freeze({
  reviewUtf8Bytes: 32_768,
  liveReviews: 16,
  reviewLifetimeMilliseconds: 300_000,
  grantLifetimeMilliseconds: 5_000,
} as const);
