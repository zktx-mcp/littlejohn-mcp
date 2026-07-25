import { deepFreezeValue } from "../core/index.js";
import {
  assertOfficialAssetSourceSnapshot,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSnapshotRevision,
  type OfficialAssetSourceSnapshot,
} from "./official-asset-contract.js";

const admittedSourceObservations = new WeakSet<object>();

declare const robinhoodOfficialAssetSourceObservationBrand: unique symbol;

export interface RobinhoodOfficialAssetSourceObservation
  extends OfficialAssetSourceSnapshot {
  readonly [robinhoodOfficialAssetSourceObservationBrand]: true;
}

export interface RobinhoodOfficialAssetSourceClient {
  read(signal: AbortSignal): Promise<RobinhoodOfficialAssetSourceObservation>;
}

export interface OfficialAssetSnapshotStore {
  readSnapshot(): CommittedOfficialAssetSnapshot | undefined;
  replaceSnapshot(
    snapshot: RobinhoodOfficialAssetSourceObservation,
    expectedRevision: OfficialAssetSnapshotRevision | null,
  ): CommittedOfficialAssetSnapshot;
}

export type RobinhoodOfficialAssetSourceErrorCode =
  | "request_aborted"
  | "source_inconsistent"
  | "source_unavailable";

const sourceErrorCodes =
  new WeakMap<object, RobinhoodOfficialAssetSourceErrorCode>();

export class RobinhoodOfficialAssetSourceError extends Error {
  override readonly name = "RobinhoodOfficialAssetSourceError";
  readonly code: RobinhoodOfficialAssetSourceErrorCode;

  constructor(code: RobinhoodOfficialAssetSourceErrorCode) {
    super(code);
    this.code = code;
    sourceErrorCodes.set(this, code);
    Object.freeze(this);
  }
}

export const getRobinhoodOfficialAssetSourceErrorCode = (
  error: unknown,
): RobinhoodOfficialAssetSourceErrorCode | undefined =>
  typeof error === "object" && error !== null
    ? sourceErrorCodes.get(error)
    : undefined;

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
  return assertOfficialAssetSourceSnapshot(
    input,
  ) as RobinhoodOfficialAssetSourceObservation;
};
