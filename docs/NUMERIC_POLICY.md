# Numeric And Asset Policy

This document is the sole authority for numeric values, units, asset identity,
decimals, conversion, arithmetic, prices, charts, serialization, and numeric
verification.

## Invariant

Numeric and unit correctness is transaction-critical. Missing, conflicting,
ambiguous, rounded, truncated, overflowed, or precision-lost values block the
affected calculation, review, or transaction.

## Canonical Amount

- The raw token integer is the canonical amount for balances, quotes, limits,
  fees, expected effects, accounting, simulation, wallet handoff, and receipts.
- Raw quantities use `BigInt` in memory.
- JSON, SQLite, MCP, HTTP, evidence, logs, and package boundaries use base-10
  integer strings.
- JavaScript `number`, binary floating point, and exponent notation never carry
  a transaction-critical or authoritative user-visible financial value. The
  non-authoritative chart projection defined below is the only display
  exception.
- Untyped bare quantities never cross a module boundary.

Every raw asset quantity observation binds:

- asset identity;
- raw integer;
- one of the decimals states defined below; and
- exactly one source position: a chain anchor, a verified registry version, or
  an explicitly unanchored pending-transaction observation.

An unanchored pending-transaction observation binds its transaction hash and
source observation, states that no inclusion block exists, and carries unknown
freshness. It permits reporting the observed raw transaction value and raw gas
rate only. It never becomes confirmed state, valuation input, accounting input,
execution readiness, or a duration guarantee.

Decimals state is exactly one of:

- `available`: an authoritative decimals value and the observation that
  supplied it;
- `not_observed`: a definition-owned static scope-exclusion identifier proving
  that the capability did not request or claim decimals evidence; or
- `unavailable`: `missing` or `conflicting` decimals evidence and the exact
  source observations that establish that result.

`not_observed` is not external evidence. It never receives a fabricated source
observation and is valid only when the owning capability definition declares
the referenced exclusion for that exact amount field. `missing` requires at
least one attempted decimals-source observation. `conflicting` requires at
least two disagreeing authoritative observations.

Asset identity is one of:

- native asset identity: chain ID and the native-asset discriminator; or
- contract-token identity: chain ID and contract address.

A raw chain quantity remains reportable when decimals are not observed or are
unavailable. It is not an interpreted amount and cannot be formatted, compared,
valued, quoted, or used for transaction construction. An interpreted amount
exists only when the required authoritative decimals are present and bound to
the same asset and observation identity.

## Token Identity And Decimals

- Contract-token identity is `chainId + contract address`.
- Symbol, name, logo, and legal underlying are separate display and registry
  metadata.
- Decimals source authority follows `docs/EVIDENCE_POLICY.md`. Execution-critical
  decimals are verified against the exact deployed contract.
- A chain decimals observation binds the exact token identity and chain anchor.
- A registry decimals observation binds the registry identifier, release
  version, record identifier, and canonical record digest.
- Little John never assumes `18`, infers decimals from a symbol or name, or
  reuses decimals from another deployment.
- Missing decimals, conflicting authoritative sources, or changed verified
  decimals invalidate dependent caches, quotes, reviews, simulations, and
  transaction material.
- Decimals disagreement fails closed.

## Display Conversion

- Display input uses an exact decimal parser.
- Fractional precision beyond the verified token decimals is rejected.
- Parsing never rounds, truncates, accepts exponent notation, or substitutes an
  approximate amount.
- Display formatting derives only from the canonical raw integer and verified
  decimals.
- A formatted value round-trips to the identical raw integer.
- A display value never becomes quoting, accounting, simulation, or transaction
  input without a new exact parse and unit binding.

## Arithmetic And Rounding

- Integer, fixed-point, arbitrary-precision decimal, or rational arithmetic owns
  every financial calculation.
- Multiplication and division preserve exact intermediate values.
- Every operation that cannot produce an exact integer declares its rounding
  direction at the protocol or policy boundary that owns the meaning.
- Rounding behavior is part of the public calculation contract and test vectors.
- Price and rate values retain numerator, denominator, base asset, quote asset,
  scale, source, and observation time.
- Price and rate comparisons use exact arithmetic rather than formatted values.
- Values with different token identities, units, scales, or observation meaning
  are never added, subtracted, or compared without an explicit conversion.

## External Boundaries

- SDK, RPC, API, registry, database, and browser values are normalized and
  validated before arithmetic.
- An SDK `number` result is display-only unless exactness for the required range
  is independently established.
- Raw contract or SDK integer results are preferred. An unavailable exact value
  blocks transaction-critical use.
- JSON integers remain strings and never pass through a JavaScript numeric
  parser.

## Transaction Type And Fees

- An [EIP-2718 transaction type](https://eips.ethereum.org/EIPS/eip-2718) is a
  nominal base-10 integer from `0` through `127`.
- Legacy transaction types `0` and `1` carry an exact gas-price value.
- Dynamic-fee transaction type `2` carries exact maximum-fee and priority-fee
  values.
- Other transaction types remain explicitly unsupported for fee interpretation
  and never enter a legacy or dynamic-fee calculation.
- Every interpreted fee value binds the native asset, raw integer, decimals
  observation, and transaction block anchor.
- A pending transaction's reported raw gas rate is not an interpreted fee value
  and follows the unanchored pending-transaction boundary above.

## Charts

- Chart source values remain exact decimal or rational values.
- A chart library may receive a finite floating-point projection only after the
  exact value is established.
- The projection is ephemeral and never stored, returned as canonical data,
  compared, or reused for financial logic.
- A UI chart must display the exact formatted value alongside the visual
  projection.

## Stock Tokens And Market Data

- Registry identifier, contract address, symbol, legal underlying, and token
  unit remain separate.
- Stock Token raw balance and UI-adjusted balance remain separate.
- A UI multiplier applies exactly once and its source and scale remain attached.
- Oracle OHLC, DEX trade OHLCV, and wallet net flow remain separate data types.
- Oracle candles contain no inferred trade volume.
- Wallet net flow is not market volume, P&L, or cost basis.
- A quote is not a candle, fill, guaranteed price, or execution result.

## Verification

An implemented numeric boundary requires audited golden vectors and
property-based invariants that cover:

- display parsing and raw formatting;
- raw-display-raw round trips;
- serialization across every boundary;
- zero and one raw unit;
- maximum supported integers and decimals;
- values above JavaScript's safe-integer range;
- pending transaction quantities without a fabricated block anchor;
- incompatible token identities and units;
- fabricated, mismatched, and undeclared `not_observed` decimals exclusions;
- every declared rounding direction;
- conflicting and changed decimals; and
- adapter and SDK normalization boundaries.
