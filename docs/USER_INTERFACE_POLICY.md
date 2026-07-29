# User Interface Policy

This document is the sole authority for browser information priority,
interaction hierarchy, visual-role meaning, responsive composition, and
accessibility presentation.

It does not own product facts, evidence meaning, numeric meaning, protocol
behavior, page paths, runtime architecture, or transaction authority. Those
remain in their owning documents and canonical contracts.

## Canonical Results

- A page presents an admitted canonical result without changing, reconstructing,
  or replacing it.
- A human summary remains a presentation projection. It is not persisted, sent
  to another interface as the canonical result, or used to recreate evidence.
- Every displayed fact is rendered from the admitted result that produced the
  summary. Admitting a field does not by itself require rendering that field.
- Approximate text is visibly identified and never becomes an input, comparison
  oracle, chart source, persisted value, or evidence value.
- Unavailable, unresolved, stale, partial, conflicting, and failed outcomes
  remain distinct. Presentation never converts one into a positive conclusion.
- The browser never asks a person to derive a product conclusion from raw
  evidence. It presents the strongest conclusion established by the owning
  contract. A conclusion the owner does not establish is labelled `Not
  established` or with the owner's unavailable state.

## Information Priority

Each page answers one current user question. Information appears in this order:

1. the question and its primary answer or action;
2. status, freshness, coverage, and limitations that change interpretation;
3. supporting comparison and context; and
4. exact values and identifiers that the person must choose, copy, compare,
   recover, or authorize.

One page region has at most one dominant answer. Equal candidates and comparable
records receive equal visual treatment.

A browser fact is present only when it directly answers the current question,
changes interpretation of the answer, identifies an exact subject or action
the person must use, supplies an accessibility-equivalent presentation, or
answers an explicitly requested technical question. Evidence replay records,
source bindings, digests, provider diagnostics, machine correlation values, and
debug fields remain in their canonical MCP, HTTP, CLI, and internal results
when they meet none of those conditions. Browser omission never removes or
rewrites canonical evidence.

A field's availability in a canonical result is not a reason to display it.
One human fact has one primary visual owner on a page. A page does not repeat
the same successful status, identifier, block, value, or explanation in its
header, summary, body, and footer merely to fill space.

A disclosure answers one named question. It is not a container for unrelated
technical fields.

Browser pagination represents a meaningful partition in the person's task. It
never exposes storage pages, RPC batches, response-size chunks, or another
machine transport boundary as interface navigation. When a browser contract
admits one complete collection under a declared bound, the page presents that
collection without cursor controls and filters it without changing or
reconstructing the admitted result.

## Visual Roles

The browser uses one implementation-owned visual token system. Pages and
provider adapters select declared roles and do not create local palettes, type
scales, corner scales, shadows, or motion rules.

The roles have these meanings:

- brand identifies Little John, selected navigation, keyboard focus, and the
  one primary action in a region;
- primary text carries page identity and the primary answer;
- secondary text explains the answer or gives supporting context;
- muted text carries subordinate metadata;
- elevated content groups one coherent region above the page;
- transient content is limited to dialogs, menus, and notifications;
- borders separate content without turning every value into a card; and
- chart colors describe only the relation between admitted chart values.

Brand color never means safe, profitable, complete, current, or executable.
Chart direction colors never mean gain, loss, recommendation, or evidence
status.

## Evidence Status

The browser has distinct roles for current, stale, partial, unavailable,
warning, and error.

- `current` means only that the owning freshness rule is satisfied.
- `stale` means that the owning freshness rule is not satisfied.
- `partial` means that the admitted result has incomplete declared coverage.
- `unavailable` means that the requested fact was not established.
- `warning` names a caution that changes interpretation.
- `error` means that the requested interaction or read failed.

Every status uses a human label and a persistent non-color marker. Color is
supporting presentation only. A limitation that changes interpretation is never
reduced to muted fine print.

## Typography

Typography expresses information priority through size, weight, color, and
spacing together.

- Page identity uses the page-heading role once.
- One primary financial answer may use the primary-value role.
- A non-financial primary answer uses the section-heading role rather than an
  oversized display style.
- Repeated comparison values use equal weight and size.
- Field labels and supporting context remain subordinate to their values.
- Exact identifiers and numbers use the exact-value role.
- Action size does not imply authorization; wording, position, and the primary
  action role express interaction priority.

Bold text is not used to fill empty space or make every value important.
Repeated list values never use page-heading or primary-value typography.

## Human Decision Information

An action or transaction review presents the canonical review owned by
`docs/TRANSACTION_POLICY.md#review-and-simulation`. It applies this document's
information priority to the admitted action meaning, authorization facts,
interpretation-changing uncertainty, and available action. It neither defines
those facts or states nor fills an unavailable conclusion from raw calldata,
hashes, digests, or source records. Canonical audit details remain subordinate
to the human authorization decision.

A read-only quote states the exact limitation admitted by its canonical
capability and does not present itself as an asset-effect or transaction
review. Presentation adds no transaction facts, simulation result, actual
effect, or readiness conclusion that the capability did not establish.

## Layout And Responsive Composition

Wide and narrow layouts preserve the same semantic reading order. A responsive
layout may stack or reflow content but never hide a comparison field, change
candidate order, move evidence ahead of the primary answer, or change action
meaning.

Every information page uses the one application-owned centered page canvas.
Pages do not create a second outer width or horizontal anchor. Named inner
widths may constrain prose, forms, summaries, tables, or dialogs only when
their semantic role requires it; they do not move the page heading or redefine
the page edges. Equivalent page actions use the same header position and
responsive order.

Only an explicitly labelled comparison table or exact-code region may scroll
horizontally. Ordinary values wrap without creating a separate scrolling box.
Long identifiers remain complete in the document and clipboard value. Their
shared visual projection uses one ellipsized line, exposes the complete value
as its title, and never forces page-level horizontal scrolling.

Whitespace and restrained separators establish hierarchy. Nested decorative
cards, page-content shadows, background effects, and empty dashboard fillers do
not substitute for information design.

## Interaction

- Opening or navigating to an information page does not connect a wallet,
  mutate product state, request a signature, or start a transaction.
- One clear primary action exists only when the current state permits it.
- Secondary actions remain available without visually competing with that
  primary action.
- A contextual action names its exact target. A result with multiple possible
  targets never receives one ambiguous action.
- One user authorization that completely determines a permitted local action
  remains one decision. Internal admission, inspection, binding, operation
  creation, and reconciliation do not become extra confirmation steps when
  they introduce no new material choice. A changed subject, effect, or
  authorization boundary requires a new explicit decision rather than silent
  continuation.
- A destructive action does not receive the same persistent list-row prominence
  as the row's primary information action. It appears in the exact subject
  context and receives its own explicit confirmation before mutation.
- A modal keeps one title and purpose. It does not open another modal or
  transform into a different task. A direct action may close the current modal
  before opening one distinct successor task; the two are never mounted
  together.
- A page location contains only inputs permitted by the architecture-owned
  browser location contract and is re-admitted by the receiving page.
- Loading, success, empty, invalid-input, unavailable, stale, partial, and
  failure states are visibly distinct and have a direct recovery action when
  the owning contract permits one.

## Accessibility

- Every page has one main landmark and one page heading.
- Every interactive element is keyboard reachable in semantic order and has a
  visible focus indicator.
- Programmatic focus identifies the changed or invalid region without removing
  visible focus.
- Status, selection, error, and chart meaning never depend on color alone.
- Controls retain a usable target size for the active pointer and layout.
- Forms keep labels, instructions, errors, and described-by relationships
  explicit. Validation does not silently rewrite the user's editable text.
- Exact chart values, time, gaps, and coverage remain usable without canvas,
  pointer input, animation, or color.
- Dialogs preserve native modality and return focus to the control that opened
  them.

## Motion

Motion communicates a direct state change only. Focus, validation errors,
loading completion, and evidence-status changes are not delayed for animation.
Looping, decorative, background, parallax, and price-celebration animation is
prohibited. Reduced-motion preference removes nonessential motion without
changing information or action availability.
