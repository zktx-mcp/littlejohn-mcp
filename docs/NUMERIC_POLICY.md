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

## Core Text, Evidence, And Read Admission Limits

Core text and identifier schemas apply these stable product admissions:

| Boundary | Maximum | Unit |
| --- | ---: | --- |
| fixed identifier | `64` | printable ASCII characters |
| snake-case code | `64` | ASCII characters |
| general single-line text | `512` | Unicode code points |
| warning message | `256` | Unicode code points |
| capability identifier | `64` | ASCII characters including its one dot |

The fixed identifier, snake-case code, and capability identifier are separate
contracts even though their current maxima are equal.

Canonical evidence applies these separate stable product admissions:

| Boundary | Maximum |
| --- | ---: |
| evidence observations | `128` |
| evidence conclusions | `64` |
| replay fact requirements | `128` |
| evidence warnings | `64` |
| observation-target roles | `8,192` |
| public replay references | `8,192` |

Observation projections consume the observation maximum. Conclusion
declarations, drafts, results, and coverage partitions consume the conclusion
maximum. Admitted fact requirements and their supporting-fact subsets consume
the fact-requirement maximum. Warning requirements and results consume the
warning maximum. Equal values do not merge these contracts. The observation
target role maximum applies to the complete static and dynamic role set owned
by one target. The public replay-reference maximum applies in aggregate across
every target in one replay. Changing the first changes evidence-definition
authoring capacity; changing the second changes public evidence-closure
capacity. Canonical JSON arrays and observation claims retain their separate
owners even when their current values equal one of these limits.

Canonical semantic reads apply these stable product admissions:

| Boundary | Maximum | Unit |
| --- | ---: | --- |
| runtime code | `262,144` | decoded bytes |
| transaction calldata | `2,097,152` | decoded bytes |
| transaction receipt | `4,096` | logs |
| transaction access list | `1,024` | entries |
| transaction access-list storage keys | `4,096` | total occurrences |
| account token request or result | `50` | token addresses |

These are canonical read-contract limits, not Ethereum maxima, provider
guarantees, measured maxima, or private adapter tuning. Changing one changes
public admission and requires an accepted contract and Numeric Policy change.
An oversized value fails admission and is not truncated into a partial result.

`readCapabilityLimits.transactionLogTopics` directly applies the EVM maximum
of four topics per log. `readCapabilityLimits.transactionType` directly
applies the EIP-2718 range owned by [Transaction Type And
Fees](#transaction-type-and-fees) and does not define a second range. These
standard-derived values are not product tuning.

## Chain Invocation And RPC Limits

Chain transport applies these current numeric boundaries:

| Boundary | Current value | Unit | Class and failure | Change meaning |
| --- | ---: | --- | --- | --- |
| exact RPC transport target | `4,096` | UTF-8 bytes | stable configuration admission; invalid input throws `TypeError` before publication or external work | changes the admitted endpoint envelope and requires target-security and Runtime-configuration review |
| per-request deadline | default and maximum `10,000`; supplied safe integer `1..10,000` | milliseconds | private transport deadline; expiry is `chain_response_unavailable` and caller abort remains `request_aborted` | changes external-resource lifetime and failure timing without changing product-data meaning |
| response body after HTTP content decoding | `8,388,608` | bytes | private transport resource guard; declared or streamed overflow is `source_inconsistent` before copying or parsing the overflowing byte | changes admitted provider bytes, memory use, and the derived block-hash maximum |
| active external RPC requests | `16` | requests per process | private process capacity shared by requester instances; excess admission is `runtime_busy` before `fetch` | changes process resource use, overload behavior, and each direct scheduler ceiling |
| JSON-RPC batch | `1..32` | calls per external request | private transport capacity; invalid cardinality throws `TypeError` before external work | changes provider compatibility and every relational consumer, but not an equal Core or feature-private limit |
| block transaction hashes | `121,574` | hash occurrences | derived normalization bound `floor((8,388,608 - 1) / 69)` for one canonical JSON hash array | cannot change independently of the response-byte boundary and canonical-array formula |
| whole Chain invocation | `90,000` | milliseconds | stable application terminal boundary; deadline is `chain_response_unavailable` | changes terminal timing for every Chain capability and requires close-and-drain review |

Target admission, request deadline, response bytes, process concurrency, batch
cardinality, and whole-invocation termination remain separate contracts. The
whole-invocation deadline is neither the sum nor the configuration of request
deadlines. Equal feature, Core, provider, local-HTTP, or release values do not
share these owners. The block-transaction maximum derives only from the
response-byte boundary and the canonical JSON array formula.

Changing one boundary requires review of its failure meaning, direct consumers,
and derived projections. It does not authorize a provider or endpoint change,
merge an equal-valued limit, or reinterpret a feature-private capacity.

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
- Trade OHLCV and wallet net flow remain separate data types.
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

### Stock Token Trade History Values

- A trade-history period is `1..365` days, `1..52` weeks, `1..12` UTC calendar
  months, or one UTC calendar year. Days and weeks are exact durations. Months
  and years use UTC calendar subtraction with missing-day clamping.
- One canonical complete success is at most `600,000` UTF-8 bytes. Core rejects
  a larger success as `result_too_large` before any interface. This is the
  current initial product admission, not the physical maximum of an interface
  serializer, a provider limit, a profile, or a version.
- A Stock Token/USDG stored candle contains exact positive reduced rational
  open, high, low, and close values, raw Stock Token and USDG volumes, trade
  count, and first and last contributing finalized `Swap` positions. Its price
  is Stock Token units quoted in USDG. These values derive together from the
  same admitted source set and are never reconstructed from chart output.
- Every Unix-epoch-aligned interval intersecting the half-open request is
  represented. The finest stored non-`1m` resolution with at most `185` natural
  positions is selected. Stored values are never split, prorated, resampled,
  interpolated or aggregated again by Little John.
- A Canvas renderer may derive only finite ephemeral price values and
  `quoteVolumeRaw / 10^quoteToken.decimals` from that completed chart series.
  These approximations are never serialized, stored, compared as financial
  values, or used to rebuild an exact field.
- The completed chart series retains its period, exact
  bounds, pair and asset units, positions, gaps, and aggregates in canonical
  JSON. Snapshot reload renders that admitted value without re-reading source
  files or aggregating the chart series.
- Human-interface chart coordinates may use only the non-authoritative
  floating-point projection allowed by [`Charts`](#charts). Exact chart times,
  OHLC values, volumes, trade counts, coverage, and source bounds remain
  available beside that projection and are the only returned or stored chart
  values.

#### Internal Archive Source

The internal archive source admits fixed stored resolutions `1m`, `15m`,
`30m`, `1h`, `2h`, `4h`, `6h`, `12h`, `1d`, and `2d` with exact interval
seconds `60`, `900`, `1,800`, `3,600`, `7,200`, `14,400`, `21,600`, `43,200`,
`86,400`, and `172,800`. It accepts only non-`1m` month members. Stored candle
prices remain positive reduced rationals; volumes and trade counts remain
positive decimal integers. Digit widths are pre-screens only. Block and source
coordinates are at most `2^256 - 1`; a Swap magnitude is at most `2^127`; one
derived trade count is at most `sourceCandleCount × Number.MAX_SAFE_INTEGER`;
and each raw volume is between that trade count and
`tradeCount × 2^127`. A stored price is admitted only when its scale can be
reversed to one positive base amount and one positive USDG amount that each fit
the signed `int128` magnitude boundary under the admitted base decimals and
fixed six USDG decimals.

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
