import {createOperationId} from "./operation-id.js";
import {RuntimeOperationError} from "./errors.js";
import {presentationPublicationKeySchema} from "./presentation-publication-key.js";
import {parseOwnerInstanceId, parseProfileId, runtimeIdentifierByteLength} from "./runtime-identity.js";
import type {WalletPreparedReview, WalletReview} from "../wallet/contracts.js";
import type {PreparedTokenSelectionReview} from "../token-catalog/review-source.js";
import type Database from "better-sqlite3";
import { canonicalJsonStringify, captureCanonicalJson, operationIdByteLength, operationIdSchema, sha256Bytes } from "../core/index.js";
import {
  admitCardRecord, isCardInputTransition, presentationCardLimits, cardKinds, type CardRecord, type PresentationCardStore, type ReadCardRecord, type DecisionCardRecord, type CardDecisionAdmission, type CardDecisionSource, type CardCreationReservation, type PreparingCardRecord,
} from "../interfaces/mcp-app/card-contract.js";
import type { PresentationSnapshotRecord, PresentationSnapshotResult } from "./presentation-snapshot.js";
import { createPresentationSnapshot } from "./presentation-snapshot-server.js";
import { CardError } from "../interfaces/mcp-app/card-errors.js";
import {presentationContractRegistry} from "../interfaces/mcp-app/registry.js";

const encoded = (record: CardRecord): string => canonicalJsonStringify(captureCanonicalJson(record));
const operationIdWidth = Math.ceil(operationIdByteLength * 4 / 3);
const runtimeIdentifierWidth = Math.ceil(runtimeIdentifierByteLength * 4 / 3);
const projection = `SELECT
  CASE WHEN octet_length(card_id) = ${operationIdWidth} THEN card_id END AS cardId,
  CASE WHEN octet_length(operation_id) = ${operationIdWidth} THEN operation_id END AS operationId,
  CASE WHEN octet_length(owner_generation) = ${runtimeIdentifierWidth} THEN owner_generation END AS ownerGeneration,
  CASE WHEN kind IN (${cardKinds.map((kind) => `'${kind}'`).join(',')}) THEN kind END AS kind,
  CASE WHEN typeof(record_json) = 'text' AND octet_length(record_json) BETWEEN 1 AND ${presentationCardLimits.recordBytes}
    THEN record_json END AS recordJson FROM presentation_card`;

const decode = (raw: unknown): CardRecord => {
  if (typeof raw !== "object" || raw === null || !("recordJson" in raw) || typeof raw.recordJson !== "string") {
    throw new CardError("runtime_state_unavailable");
  }
  let record: CardRecord;
  try {
    record = admitCardRecord(JSON.parse(raw.recordJson));
    parseOwnerInstanceId("ownerGeneration" in raw ? raw.ownerGeneration : undefined);
  }
  catch { throw new CardError("runtime_state_unavailable"); }
  if (encoded(record) !== raw.recordJson || !("cardId" in raw) || raw.cardId !== record.cardId ||
      !("operationId" in raw) || raw.operationId !== (record.kind === "read" || record.kind === "preparing" ? null : record.operationId) || !("kind" in raw) || raw.kind !== record.kind) {
    throw new CardError("runtime_state_unavailable");
  }
  return record;
};

interface Access {
  read<T>(operation: () => T): T;
  write<T>(operation: () => T): T;
}

export const createPresentationCardStore = (
  database: Database.Database, access: Access, snapshots: {
    insert(record: PresentationSnapshotRecord): PresentationSnapshotResult<PresentationSnapshotRecord>;
    currentOwner(): Readonly<{profileId: string; ownerGeneration: string}>;
    commitWalletReview(prepared: WalletPreparedReview): WalletReview;
    commitTokenReview(prepared: PreparedTokenSelectionReview): unknown;
  },
): PresentationCardStore => {
  const read = (where: string, values: readonly string[]): CardRecord | null => {
    const row = database.prepare(`${projection} WHERE ${where}`).get(...values);
    if (row === undefined) return null;
    const record = decode(row);
    const generation = parseOwnerInstanceId((row as {ownerGeneration: unknown}).ownerGeneration);
    const owner = snapshots.currentOwner();
    const publication = database.prepare(`SELECT
      CASE WHEN typeof(profile_id) = 'text' AND octet_length(profile_id) = ${runtimeIdentifierWidth} THEN profile_id END AS profileId,
      CASE WHEN typeof(owner_generation) = 'text' AND octet_length(owner_generation) = ${runtimeIdentifierWidth} THEN owner_generation END AS ownerGeneration,
      CASE WHEN stage IN ('creating', 'created') THEN stage END AS stage
      FROM presentation_publication WHERE card_id = ?`).get(record.cardId) as {profileId: unknown; ownerGeneration: unknown; stage: unknown} | undefined;
    if (publication !== undefined && (publication.profileId !== owner.profileId || publication.ownerGeneration !== generation ||
      (publication.stage !== "creating" && publication.stage !== "created") ||
      (publication.stage === "creating") !== (record.kind === "preparing" && record.creationState === "creating"))) throw new CardError("runtime_state_unavailable");
    if (generation === owner.ownerGeneration) return record;
    const next = record.kind === "preparing" && record.creationState === "creating"
      ? admitCardRecord({...record, creationState: "owner_lost"})
      : record.kind === "read" && record.preparationState === "pending"
        ? admitCardRecord({...record, preparationState: "failed", outcome: {kind: "failure", failureCode: "runtime_state_unavailable"}})
        : record.kind !== "preparing" && record.kind !== "read" && record.inputState === "input_pending"
          ? admitCardRecord({...record, inputState: "input_closed", closeReason: "owner_lost", dispatchId: null}) : record;
    if (encoded(next) !== encoded(record)) {
      if (!database.inTransaction) throw new CardError("runtime_state_unavailable");
      if (database.prepare("UPDATE presentation_card SET record_json = ? WHERE card_id = ? AND owner_generation = ? AND record_json = ?")
        .run(encoded(next), record.cardId, generation, encoded(record)).changes !== 1) throw new CardError("state_conflict");
      if (record.kind === "preparing") database.prepare("UPDATE presentation_publication SET stage = 'created' WHERE card_id = ? AND owner_generation = ? AND stage = 'creating'")
        .run(record.cardId, generation);
    }
    return next;
  };
  const creations = new WeakMap<CardCreationReservation, Readonly<{record: PreparingCardRecord; ownerGeneration: string; publicationKey: string | null}>>();
  const admissions = new WeakMap<CardDecisionAdmission, Readonly<{expected: DecisionCardRecord; dispatchId: string; callerSignal: AbortSignal | undefined}>>();
  const admittedCards = new Map<string, CardDecisionAdmission>();
  const same = (left: CardRecord, right: CardRecord): boolean => encoded(left) === encoded(right);
  const identity = (record: CardRecord): string => {
    if (record.kind === "preparing") return encoded(record);
    if (record.kind === "read") {
      const {preparationState: _state, snapshotId: _snapshot, outcome: _outcome, ...source} = record;
      return canonicalJsonStringify(captureCanonicalJson(source));
    }
    const {inputState: _input, closeReason: _reason, dispatchId: _dispatch, outcome: _outcome, ...source} = record;
    return canonicalJsonStringify(captureCanonicalJson(source));
  };
  const writeReplacement = (expectedInput: CardRecord, nextInput: CardRecord): CardRecord => {
    const expected = admitCardRecord(expectedInput);
    const next = admitCardRecord(nextInput);
    if (expected.kind === "preparing" || next.kind === "preparing" || identity(expected) !== identity(next) || expected.kind !== next.kind ||
        (expected.kind === "read" ? next.kind !== "read" ||
          (expected.preparationState !== "pending" && !same(expected, next)) :
          next.kind === "read" || !isCardInputTransition(expected, next) ||
          (expected.outcome !== null && expected.outcome.kind !== "delivery" && !same(expected, next)))) {
      throw new CardError("presentation_inconsistent");
    }
    const current = read("card_id = ?", [expected.cardId]);
      if (current === null || !same(current, expected)) throw new CardError("state_conflict");
      if (same(current, next)) return current;
      const result = database.prepare("UPDATE presentation_card SET record_json = ? WHERE card_id = ? AND record_json = ?")
        .run(encoded(next), expected.cardId, encoded(expected));
      if (result.changes !== 1) throw new CardError("state_conflict");
    return next;
  };
  const replace = (expected: CardRecord, next: CardRecord): CardRecord => access.write(() => {
    const result = writeReplacement(expected, next);
    return result;
  });
  return Object.freeze({
    read(cardId) { return access.write(() => read("card_id = ?", [cardId])); },
    replace,
    prepareDecision(expectedInput, dispatchIdInput, callerSignal) {
      const expected = admitCardRecord(expectedInput);
      const dispatchId = operationIdSchema.parse(dispatchIdInput);
      if ((expected.kind === "read" || expected.kind === "preparing") || expected.inputState !== "input_pending") throw new CardError("state_conflict");
      access.write(() => {
        const current = read("card_id = ?", [expected.cardId]);
        if (current === null || !same(current, expected) || admittedCards.has(expected.cardId)) throw new CardError("state_conflict");
      });
      const admission = Object.freeze({}) as CardDecisionAdmission;
        if (callerSignal?.aborted) throw new RuntimeOperationError("request_aborted");
        admissions.set(admission, Object.freeze({expected, dispatchId, callerSignal}));
      admittedCards.set(expected.cardId, admission);
      return admission;
    },
    commitDecision(admission, source: CardDecisionSource, outcome) {
      const captured = admissions.get(admission);
      if (captured === undefined || admittedCards.get(captured.expected.cardId) !== admission) throw new CardError("invalid_input");
      const {expected, dispatchId} = captured;
      try {
        if (captured.callerSignal?.aborted) throw new RuntimeOperationError("request_aborted");
        if (source.kind !== expected.kind || (source.kind === "wallet_selection"
          ? expected.kind !== "wallet_selection" || source.connectionId !== expected.context.connectionId ||
            source.chainId !== expected.context.chainId || source.connectionRevision !== expected.context.originalConnectionRevision
          : source.operationId !== expected.operationId || source.resultDigest !== expected.resultDigest)) throw new CardError("state_conflict");
        return access.write(() => writeReplacement(expected, {...expected, inputState: "input_closed", closeReason: "submitted", dispatchId,
          outcome: outcome ?? null}) as DecisionCardRecord);
      } finally {
        admittedCards.delete(expected.cardId);
        admissions.delete(admission);
      }
    },
    discardDecision(admission) {
      const captured = admissions.get(admission);
      if (captured !== undefined && admittedCards.get(captured.expected.cardId) === admission) admittedCards.delete(captured.expected.cardId);
      admissions.delete(admission);
    },
    beginCreation(sourceKind, normalizedInput, publicationKeyInput) {
      const publicationKey = publicationKeyInput === null ? null : presentationPublicationKeySchema.parse(publicationKeyInput);
      return access.write(() => {
        const owner = snapshots.currentOwner();
        const profileId = parseProfileId(owner.profileId);
        const ownerGeneration = parseOwnerInstanceId(owner.ownerGeneration);
        if (publicationKey !== null) {
          const row = database.prepare(`SELECT
            CASE WHEN octet_length(card_id) = ${operationIdWidth} THEN card_id END AS cardId,
            CASE WHEN octet_length(owner_generation) = ${runtimeIdentifierWidth} THEN owner_generation END AS ownerGeneration,
            CASE WHEN stage IN ('creating', 'created') THEN stage END AS stage FROM presentation_publication
            WHERE profile_id = ? AND publication_key = ?`).get(profileId, publicationKey) as {cardId: string; ownerGeneration: string; stage: string} | undefined;
          if (row !== undefined) {
            const cardId = operationIdSchema.parse(row.cardId);
            parseOwnerInstanceId(row.ownerGeneration);
            const retained = read("card_id = ?", [cardId]);
            if (row.stage === "creating" && row.ownerGeneration !== ownerGeneration && retained?.kind === "preparing" && retained.creationState === "owner_lost") return {status: "existing" as const, cardId};
            if (retained === null || (row.stage !== "creating" && row.stage !== "created") ||
                (row.stage === "creating") !== (retained.kind === "preparing" && retained.creationState === "creating")) {
              throw new CardError("runtime_state_unavailable");
            }
            if (row.stage === "creating" && row.ownerGeneration !== ownerGeneration) {
              if (retained.kind !== "preparing") throw new CardError("presentation_inconsistent");
              database.prepare("UPDATE presentation_card SET record_json = ? WHERE card_id = ? AND record_json = ?")
                .run(encoded({...retained, creationState: "owner_lost"}), cardId, encoded(retained));
              database.prepare("UPDATE presentation_publication SET stage = 'created' WHERE profile_id = ? AND publication_key = ?")
                .run(profileId, publicationKey);
              return {status: "existing" as const, cardId};
            }
            return {status: row.stage === "created" ? "existing" as const : "creating" as const, cardId};
          }
        }
        const cardId = createOperationId();
        const record = admitCardRecord({cardId, kind: "preparing", contractVersion: "1", sourceKind,
          inputDigest: sha256Bytes(new TextEncoder().encode(encodedValue(normalizedInput))), creationState: "creating"});
        if (record.kind !== "preparing") throw new CardError("presentation_inconsistent");
        database.prepare("INSERT INTO presentation_card(card_id, owner_generation, kind, operation_id, record_json) VALUES (?, ?, 'preparing', NULL, ?)")
          .run(cardId, ownerGeneration, encoded(record));
        if (publicationKey !== null) database.prepare("INSERT INTO presentation_publication(profile_id, publication_key, card_id, owner_generation, stage) VALUES (?, ?, ?, ?, 'creating')")
          .run(profileId, publicationKey, cardId, ownerGeneration);
        const reservation = Object.freeze({}) as CardCreationReservation;
        creations.set(reservation, Object.freeze({record, ownerGeneration, publicationKey}));
        return {status: "reserved" as const, cardId, reservation};
      });
    },
    commitCreation(reservation, recordInput, snapshotInput, walletReview, tokenReview) {
      const captured = creations.get(reservation);
      if (captured === undefined) throw new CardError("invalid_input");
      const candidate = admitCardRecord(recordInput);
      if (candidate.kind === "preparing" || candidate.cardId !== captured.record.cardId ||
          (candidate.kind !== captured.record.sourceKind && !(captured.record.sourceKind === "wallet" && candidate.kind === "read" && candidate.preparationState === "completed")) ||
          (candidate.snapshotId !== null) !== (snapshotInput !== undefined)) {
        throw new CardError("presentation_inconsistent");
      }
      const result = access.write(() => {
        const owner = snapshots.currentOwner();
        const current = read("card_id = ?", [captured.record.cardId]);
        if (owner.ownerGeneration !== captured.ownerGeneration || current === null || !same(current, captured.record)) throw new CardError("state_conflict");
        if (walletReview !== undefined) {
          if (candidate.kind !== "wallet" || tokenReview !== undefined || walletReview.review.operationId !== candidate.operationId ||
              sha256Bytes(new TextEncoder().encode(encodedValue({status: "review", review: walletReview.review}))) !== candidate.resultDigest) {
            throw new CardError("presentation_inconsistent");
          }
          snapshots.commitWalletReview(walletReview);
        }
        if (tokenReview !== undefined) {
          if (candidate.kind !== "token_selection" || tokenReview.result.review.operationId !== candidate.operationId ||
              sha256Bytes(new TextEncoder().encode(encodedValue(tokenReview.result))) !== candidate.resultDigest) {
            throw new CardError("presentation_inconsistent");
          }
          snapshots.commitTokenReview(tokenReview);
        }
        if (snapshotInput !== undefined) {
          const prepared = createPresentationSnapshot(snapshotInput);
          if (prepared.status !== "available" || candidate.snapshotId !== prepared.value.snapshotId ||
              candidate.contractVersion !== prepared.value.contractVersion ||
              (candidate.kind === "read" ? candidate.contractId !== prepared.value.contractId || candidate.inputDigest !== prepared.value.inputDigest
                : candidate.resultDigest !== prepared.value.resultDigest ||
                  presentationContractRegistry.requireCardKind(candidate.kind).contractId !== prepared.value.contractId)) {
            throw new CardError("presentation_inconsistent");
          }
          const preparedInput = walletReview?.input ?? tokenReview?.input;
          if (preparedInput !== undefined && encodedValue(preparedInput) !== encodedValue(snapshotInput.normalizedInput)) {
            throw new CardError("presentation_inconsistent");
          }
          const inserted = snapshots.insert(prepared.value);
          if (inserted.status !== "available") throw new CardError(inserted.reason === "capacity_exceeded" ? "presentation_capacity_exceeded" : "runtime_state_unavailable");
        }
        const updated = database.prepare("UPDATE presentation_card SET kind = ?, operation_id = ?, record_json = ? WHERE card_id = ? AND record_json = ? AND owner_generation = ?")
          .run(candidate.kind, candidate.kind === "read" ? null : candidate.operationId, encoded(candidate), candidate.cardId, encoded(captured.record), captured.ownerGeneration);
        if (updated.changes !== 1) throw new CardError("state_conflict");
        if (captured.publicationKey !== null) {
          const published = database.prepare("UPDATE presentation_publication SET stage = 'created' WHERE profile_id = ? AND publication_key = ? AND card_id = ? AND owner_generation = ? AND stage = 'creating'")
            .run(owner.profileId, captured.publicationKey, candidate.cardId, captured.ownerGeneration);
          if (published.changes !== 1) throw new CardError("state_conflict");
        }
        return candidate;
      });
      creations.delete(reservation);
      return result;
    },
    discardCreation(reservation) {
      const captured = creations.get(reservation);
      if (captured === undefined) return;
      access.write(() => {
        const current = read("card_id = ?", [captured.record.cardId]);
        // A late transport failure cannot release a completed publication.
        if (current === null || current.kind !== "preparing" || !same(current, captured.record)) return;
        if (captured.publicationKey !== null) database.prepare("DELETE FROM presentation_publication WHERE card_id = ? AND stage = 'creating' AND owner_generation = ?")
          .run(captured.record.cardId, captured.ownerGeneration);
        database.prepare("DELETE FROM presentation_card WHERE card_id = ? AND record_json = ? AND owner_generation = ?")
          .run(captured.record.cardId, encoded(captured.record), captured.ownerGeneration);
      });
      creations.delete(reservation);
    },
    completeRead(expected, input) {
      if (expected.preparationState !== "pending" || input.contractId !== expected.contractId ||
          input.contractVersion !== expected.contractVersion ||
          sha256Bytes(new TextEncoder().encode(encodedValue(input.normalizedInput))) !== expected.inputDigest) throw new CardError("presentation_inconsistent");
      const prepared = createPresentationSnapshot(input);
      if (prepared.status === "unavailable") throw new CardError(prepared.reason === "capacity_exceeded" ? "presentation_capacity_exceeded" : "runtime_state_unavailable");
      return access.write(() => {
        const current = read("card_id = ?", [expected.cardId]);
        if (current === null || !same(current, expected)) throw new CardError("state_conflict");
        const committed = snapshots.insert(prepared.value);
        if (committed.status === "unavailable") throw new CardError(committed.reason === "capacity_exceeded"
          ? "presentation_capacity_exceeded" : "runtime_state_unavailable");
        // An exception in the conditional card write rolls back the snapshot too.
        return writeReplacement(expected, {...expected, preparationState: "completed", snapshotId: committed.value.snapshotId, outcome: {kind: "snapshot"}}) as ReadCardRecord;
      });
    },
  } satisfies PresentationCardStore);
};

const encodedValue = (value: unknown): string => canonicalJsonStringify(captureCanonicalJson(value));
