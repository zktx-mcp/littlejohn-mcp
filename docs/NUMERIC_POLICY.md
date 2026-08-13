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
- An EVM RPC raw asset amount is between zero and `2^256 - 1` inclusive. A
  larger structurally valid decimal string is not an EVM balance.
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
- `not_observed`: a reason code declared by the capability definition, proving
  that the capability did not request or claim decimals evidence; or
- `unavailable`: `missing` or `conflicting` decimals evidence and the exact
  source observations that establish that result.

`not_observed` is not external evidence. It never receives a fabricated source
observation and is valid only when the owning capability definition declares
the referenced exclusion for that exact amount field. `missing` requires at
least one attempted decimals-source observation. `conflicting` requires at
least two disagreeing authoritative observations.

Asset identity uses one canonical EIP-155 CAIP-2 chain ID and is one of:

- native asset identity: chain ID and the native-asset discriminator; or
- contract-token identity: chain ID and canonical lowercase EVM contract
  address.

A raw chain quantity remains reportable when decimals are not observed or are
unavailable. It is not an amount with verified decimals and cannot be formatted,
compared, valued, quoted, or used for transaction construction. An amount with
verified decimals exists only when the required authoritative decimals are
present and bound to the same asset and observation identity.

## Token Identity And Decimals

- Contract-token identity is canonical EIP-155 `chainId + contract address`.
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
- An exact human-input parser accepts one unsigned plain decimal with no leading integer zeroes,
  except for zero itself. A decimal point requires at least one following digit.
  Signs, whitespace, grouping separators, and exponent notation are rejected.
- Fractional precision beyond the verified token decimals is rejected.
- Parsing never rounds, truncates, accepts exponent notation, or substitutes an
  approximate amount.
- The parsed integer must fit the EVM `uint256` range. A surface that accepts
  human amount input bounds its input before parsing.
- Display formatting derives only from the canonical raw integer and verified
  decimals.
- The account-asset human view removes leading integer zeroes, inserts the
  decimal point implied by verified decimals, and removes trailing fractional
  zeroes. Zero is `0`; no exponent notation, locale separator, rounding, or
  `number` conversion is used. The raw integer remains canonical and remains
  available to exact machine projections. Human presentation follows
  `docs/USER_INTERFACE_POLICY.md` and does not display the raw integer merely
  because the canonical result contains it.
- A formatted value round-trips to the identical raw integer.
- A display value never becomes quoting, accounting, simulation, or transaction
  input without a new exact parse and unit binding.
- Zero may be paired with the exact asset symbol in human presentation without
  an admitted decimals value because every decimal scale represents zero as
  zero. A nonzero raw quantity without admitted decimals is not formatted or
  labelled as a human asset amount. A human interface may present its amount
  as unavailable while exact machine projections retain the canonical raw
  value.

### Rational Display

- One interface-neutral core owner formats a nonnegative reduced rational for
  human display with at most eight significant base-10 digits.
- It uses round-half-to-even once, removes trailing fractional zeroes, and
  reports whether the display is exact or approximate.
- Plain notation is used when the normalized base-10 exponent is from `-6`
  through `15`, inclusive. Other values use a coefficient and signed exponent.
- Rounding that changes a coefficient from `9.9999999` to `10` increments the
  exponent before notation is selected.
- Zero is exact `0`. Every positive rational remains visibly positive and is
  never collapsed into a shared threshold label.
- Exponent selection, rounding, and notation use integer cross-products and
  `BigInt` only. No logarithm, floating-point value, or intermediate formatted
  decimal participates.
- The exact fraction remains the authority. Approximate text is a display
  projection and never becomes an input, comparison value, chart source,
  persisted value, or evidence value.
- A raw-output-units-per-raw-input-unit price is converted to an exact reduced
  output-token-units-per-input-token rational by applying both admitted decimal
  scales once. Human-interface consumers use that object and do not parse a
  fraction string to recover it.

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

- SDK, RPC, API, registry, database, and interface values are normalized and
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
- Stock Token raw balance and human-display-adjusted balance remain separate.
- A verified current ERC-8056 multiplier applies exactly once. For raw
  balance `raw` and current multiplier `multiplier`, both unsigned integers,
  the adjusted raw amount is exactly
  `floor(raw * multiplier / 1000000000000000000)`. The implementation uses
  arbitrary-precision integer arithmetic and never converts either operand or
  the intermediate product to a JavaScript `number`.
- The current multiplier, its `10^18` scale, token identity, account identity,
  and canonical block remain attached to the adjusted result. A pending
  multiplier is reported as pending evidence and is not applied as the current
  value.
- Missing, malformed, contradictory, or out-of-range multiplier evidence leaves
  the raw balance intact and produces no adjusted amount.
- Oracle OHLC, DEX trade OHLCV, and wallet net flow remain separate data types.
- Oracle candles contain no inferred trade volume.
- Wallet net flow is not market volume, P&L, or cost basis.
- A quote is not a candle, fill, guaranteed price, or execution result.

### Uniswap V2 Exact-Input Values

- The quote input and every candidate output are raw unsigned token integers.
- One V2 hop calculates
  `floor(amountIn * 997 * reserveOut / (reserveIn * 1000 + amountIn * 997))`.
  The package uses arbitrary-precision integer arithmetic, preserves the
  downward rounding required by integer division, and reports
  `arithmetic_overflow` for a candidate when a checked EVM `uint256` operation
  would overflow.
- V2 reserves are admitted as `uint112` values. Pair direction follows the
  admitted token order; reserves are never paired by symbol or display order.
- Mid price, execution price, and price impact are reduced nonnegative rational
  values. Zero price impact is exactly `0/1`.
- Token decimals label raw units and the SDK comparison. They do not enter the
  independent raw-unit output calculation. Endpoint decimal failure makes the
  quote unavailable; an unavailable intermediary decimal leaves the independent
  quote reportable and makes only the SDK comparison unavailable.
- The human CLI view labels the canonical raw-unit price separately. It derives
  the exact token-unit price as
  `rawPrice * 10^inputDecimals / 10^outputDecimals`, reduce the resulting
  rational, and display it without converting any component to a JavaScript
  `number`. This display value is not written back into the canonical quote.
- SDK comparison never supplies, rounds, or replaces a canonical quote value.

### Reference Market Values

- A reference-market value is a positive reduced rational with base-10 string
  `numerator` and `denominator`. It retains the exact pair identity, source
  round identities, canonical chain block, actual read time, and freshness
  result that produced it. A source round update time remains a distinct feed
  fact and is never used as the read time.
- A direct feed answer `answer` with `decimals` is exactly
  `answer / 10^decimals`. A nonpositive answer, invalid round identity, future
  update time, or malformed decimals produces no reference value.
- A Robinhood Stock Token feed value is Chainlink's tokenized-equity Total
  Return Value. It already applies the Stock Token multiplier. Little John does
  not multiply it by the catalog multiplier, token decimals, or any other
  multiplier again. Robinhood underlying-equity bid or ask, a DEX quote, a
  trade, a fill, and a balance are different units and cannot replace it.
- A Stock Token value is `current` only when its exact positive round is not in
  the future, its age is within the mapped heartbeat, and the same-block token
  `oraclePaused()` observation is `false`. A valid older or paused value is
  `last_observed`. Pause and age are reported independently; a clock does not
  infer weekends, holidays, exchange sessions, or trading halts.
- ETH/USDG is exactly ETH/USD divided by USDG/USD. Its reduced rational is
  `(ethAnswer * 10^usdgDecimals) / (usdgAnswer * 10^ethDecimals)`. Current cross
  construction requires both source rounds to be fresh at the same canonical
  block; one stale leg makes the current cross unavailable.
- Historical cross construction considers each source update time. For that
  time it selects the latest observation from each source that is not later than
  the candidate time and requires each selected observation to be within its
  feed heartbeat. It never fills from the future, interpolates, averages, or
  substitutes a midpoint.
- The `1d`, `7d`, and `30d` windows use UTC buckets of 15 minutes, 1 hour, and 4
  hours respectively. Each candle's open and close are the first and last exact
  points in its bucket; high and low use exact rational comparison. A natural
  bucket `[openedAt, naturalEnd)` is closed when `naturalEnd` is not later than
  the canonical block time and excludes a point exactly at `naturalEnd`. Only a
  bucket truncated by a block time before `naturalEnd` is open, and it includes
  an admitted point exactly at that block time. The first represented bucket
  begins at the first UTC bucket boundary not earlier than the requested start;
  the unaligned prefix is not a bucket. Candle starts and empty-bucket starts
  partition the represented bucket starts. An empty bucket means only that no
  admitted point appears in that bucket; neither a candle nor an empty bucket
  proves exhaustive source history. Every candle has no trade volume.
- One Stock Token market result keeps two numeric series separate. Its
  Chainlink Total Return Value and reference history are denominated in USD and
  retain the direct-feed rules above. Its Uniswap V4 executed-trade history is
  denominated in USDG and contains exact one-minute OHLC values, raw Stock
  Token and USDG volumes, and trade count derived by the admitted index from
  exact `Swap` events. Little John does not convert USDG to USD, compare the two
  series as equal units, merge their candles, interpolate a missing interval,
  or derive either series from the other.
- The Chainlink reference chart admits at most 180 candles and 720 distinct
  source observations. The execution chart admits at most the most recent
  3,072 exact one-minute candles from the requested interval and reports any
  earlier result-capacity loss. A valid current or last-observed reference
  value can coexist with partial, stale, unavailable, retained-out, or
  capacity-limited execution history; neither outcome changes the other.
- Human-interface chart coordinates may use only the non-authoritative
  floating-point projection allowed by [`Charts`](#charts). Exact rational
  OHLC values remain visible beside that projection and are the only values
  returned or stored.

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

## Contract Control Enumeration

One contract analysis admits at most `8,192` declared function signatures, and
each canonical signature contains at most `1,024` UTF-16 code units. Core owns
both limits. The source-verification adapter consumes them and does not copy
them. The adapter's smaller response-byte limit further bounds the functions
that one provider response can supply.

One contract-analysis result admits at most `32` observed default-administrator
members. The limit bounds one public result and one same-block RPC batch.
An observed count above the limit produces the explicit `limit_exceeded`
result and no member calls. Returned members are canonical addresses in
strict code-point order with no duplicates.

This public limit is owned by the contract-analysis core contract. The chain
adapter verifies that it does not exceed the chain RPC batch limit and does not
copy or redefine either value. Source-provider response size, request deadline,
and active-request limits are private adapter resource controls and do not
change this public enumeration limit.
