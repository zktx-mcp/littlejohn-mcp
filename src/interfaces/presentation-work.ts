import {presentationSnapshotLimits} from "../runtime/presentation-snapshot.js";
import {RuntimeOperationError} from "../runtime/errors.js";

// The former empty-history admission envelope now bounds only unsettled work.
// These are reserved result bytes, not a measured process-memory guarantee.
export const presentationWorkLimits = Object.freeze({slots: 16_384, reservedBytes: 536_870_912});
export interface PresentationWorkPermit { release(): void }

export class PresentationWorkBudget {
  #slots = 0;
  #bytes = 0;

  reserveCreation(): PresentationWorkPermit { return this.#reserve(0); }

  reserveRead(inputBytes: number): PresentationWorkPermit {
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 1 || inputBytes > presentationSnapshotLimits.inputBytes) {
      throw new RuntimeOperationError("invalid_input");
    }
    return this.#reserve(inputBytes + presentationSnapshotLimits.resultBytes);
  }

  #reserve(bytes: number): PresentationWorkPermit {
    if (this.#slots >= presentationWorkLimits.slots || this.#bytes + bytes > presentationWorkLimits.reservedBytes) {
      throw new RuntimeOperationError("runtime_busy");
    }
    this.#slots += 1;
    this.#bytes += bytes;
    let released = false;
    return Object.freeze({release: (): void => {
      if (released) return;
      released = true;
      this.#slots -= 1;
      this.#bytes -= bytes;
    }});
  }
}
