import { deepFreezeValue } from "../core/index.js";
import {
  assertOfficialAssetSourceSnapshot,
  officialAssetSourceUnavailableReasonSchema,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSnapshotRevision,
  type OfficialAssetSourceUnavailableReason,
  type OfficialAssetSourceSnapshot,
} from "./official-asset-contract.js";

const admittedSourceObservations = new WeakSet<object>();

declare const robinhoodOfficialAssetSourceObservationBrand: unique symbol;

export interface RobinhoodOfficialAssetSourceObservation
  extends OfficialAssetSourceSnapshot {
  readonly [robinhoodOfficialAssetSourceObservationBrand]: true;
}

export interface RobinhoodOfficialAssetSourceClient {
  read(signal: AbortSignal): Promise<RobinhoodOfficialAssetSourceReadResult>;
}

export interface OfficialAssetSnapshotStore {
  readSnapshot(): CommittedOfficialAssetSnapshot | undefined;
  replaceSnapshot(
    snapshot: RobinhoodOfficialAssetSourceObservation,
    expectedRevision: OfficialAssetSnapshotRevision | null,
  ): CommittedOfficialAssetSnapshot;
}

export type RobinhoodOfficialAssetSourceObservedResult = Readonly<{
  status: "observed";
  observation: RobinhoodOfficialAssetSourceObservation;
}>;

export type RobinhoodOfficialAssetSourceUnavailableResult = Readonly<{
  status: "unavailable";
  reason: OfficialAssetSourceUnavailableReason;
}>;

export type RobinhoodOfficialAssetSourceReadResult =
  | RobinhoodOfficialAssetSourceObservedResult
  | RobinhoodOfficialAssetSourceUnavailableResult;

export const officialAssetSourceUnavailable = (
  reason: OfficialAssetSourceUnavailableReason,
): RobinhoodOfficialAssetSourceUnavailableResult => Object.freeze({
  status: "unavailable",
  reason: officialAssetSourceUnavailableReasonSchema.parse(reason),
});

export const officialAssetSourceObserved = (
  observation: RobinhoodOfficialAssetSourceObservation,
): RobinhoodOfficialAssetSourceObservedResult => Object.freeze({
  status: "observed",
  observation: assertRobinhoodOfficialAssetSourceObservation(observation),
});

export const admitRobinhoodOfficialAssetSourceObservation = (
  input: OfficialAssetSourceSnapshot,
): RobinhoodOfficialAssetSourceObservation => {
  const observation = assertOfficialAssetSourceSnapshot(
    input,
  ) as RobinhoodOfficialAssetSourceObservation;
  admittedSourceObservations.add(observation);
  return deepFreezeValue(observation);
};

export const assertRobinhoodOfficialAssetSourceObservation = (
  input: RobinhoodOfficialAssetSourceObservation,
): RobinhoodOfficialAssetSourceObservation => {
  if (!admittedSourceObservations.has(input)) {
    throw new TypeError(
      "The official asset snapshot was not admitted from the source response.",
    );
  }
  return input;
};
