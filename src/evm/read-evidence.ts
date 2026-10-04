import type {CanonicalAmount} from "./amounts.js";
import {type BoundEvidenceObservationSlotDeclaration, type BoundEvidenceClaimRoleDeclaration, type ObservationReference} from "../core/client.js";
import {observationReference} from "../core/client.js";

export const amountObservationReferences = (
  amount: CanonicalAmount,
  quantity: Readonly<{
    readonly slot: BoundEvidenceObservationSlotDeclaration;
    readonly role: BoundEvidenceClaimRoleDeclaration;
  }>,
  decimals?: Readonly<{
    readonly slot: BoundEvidenceObservationSlotDeclaration;
    readonly role: BoundEvidenceClaimRoleDeclaration;
  }>,
): readonly ObservationReference[] => {
  const references = [
    observationReference(amount.quantityObservationId, quantity.slot, quantity.role),
  ];
  if (amount.decimals.status === "not_observed") return references;
  if (decimals === undefined) {
    throw new TypeError("Observed decimals require a public observation reference.");
  }
  const observationIds = amount.decimals.status === "available"
    ? [amount.decimals.observationId]
    : amount.decimals.observationIds;
  return [
    ...references,
    ...observationIds.map((observationId) =>
      observationReference(observationId, decimals.slot, decimals.role)),
  ];
};
