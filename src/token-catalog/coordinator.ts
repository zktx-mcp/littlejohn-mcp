import { randomBytes } from "node:crypto";

import {
  addUtcMilliseconds,
  sameEvmAccountIdentity,
  canonicalJsonStringify,
  type CanonicalClock,
  type CanonicalJson,
  type OperationId,
  type UtcTimestamp,
} from "../core/index.js";
import {
  requireAvailableAddressTarget,
  sameResolvedAddressTarget,
  type ResolvedAddressTarget,
} from "../chain/address-target.js";
import {
  findOfficialAssetMember,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSourceMember,
} from "../registry/index.js";
import { createOperationId } from "../runtime/operation-id.js";
import {
  createTokenAdditionReviewProjection,
  parseTokenSelectionReview,
  tokenCatalogApplicationContracts,
  tokenCatalogContractLimits,
  tokenCatalogOperationIdSchema,
  tokenSelectionDirectActionSchema,
  tokenSelectionReviewDigest,
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
  type TokenCatalogOperation,
  type TokenInspectionSuccess,
  type TokenSelection,
  type TokenSelectionDirectAction,
  type TokenSelectionReview,
  type TokenSelectionReviewRequest,
  type TokenSelectionReviewResult,
} from "./contracts.js";
import { normalizeTokenCatalogError, TokenCatalogOperationError } from "./operation-error.js";
import type {
  TokenCatalogCoordinatorDependencies,
  TokenCatalogOperationCoordinatorPort,
} from "./ports.js";

export const tokenCatalogCoordinatorPolicy = Object.freeze({
  userActionMilliseconds: tokenCatalogContractLimits.reviewActionMilliseconds,
});

const createSelectionRevision = () => tokenSelectionRevisionSchema.parse(
  randomBytes(tokenCatalogContractLimits.selectionRevisionBytes).toString("base64url"),
);
const createSelectionSetRevision = () => tokenSelectionSetRevisionSchema.parse(
  randomBytes(tokenCatalogContractLimits.selectionRevisionBytes).toString("base64url"),
);

export interface TokenCatalogCoordinatorRuntimeDependencies extends TokenCatalogCoordinatorDependencies {
  readonly clock: CanonicalClock;
  readonly signal: AbortSignal;
}

const sameSelection = (
  left: TokenSelection | null,
  right: TokenSelection | null,
): boolean => canonicalJsonStringify(left as unknown as CanonicalJson) ===
  canonicalJsonStringify(right as unknown as CanonicalJson);

const sameReview = (left: TokenSelectionReview, right: TokenSelectionReview): boolean =>
  canonicalJsonStringify(left as unknown as CanonicalJson) ===
    canonicalJsonStringify(right as unknown as CanonicalJson);

export class TokenCatalogCoordinator implements TokenCatalogOperationCoordinatorPort {
  readonly #dependencies: TokenCatalogCoordinatorRuntimeDependencies;
  readonly #controllers = new Set<AbortController>();
  readonly #activeCalls = new Set<Promise<void>>();
  #lifecycleState: "open" | "closing" | "closed" = "open";
  #closePromise?: Promise<void>;

  constructor(dependencies: TokenCatalogCoordinatorRuntimeDependencies) {
    this.#dependencies = dependencies;
    Object.seal(this);
  }

  review(inputValue: TokenSelectionReviewRequest): Promise<TokenSelectionReviewResult> {
    return this.#run(async (signal) => {
      const input = tokenCatalogApplicationContracts.selectionChangeReview.parseInput(inputValue);
      const operationId = tokenCatalogOperationIdSchema.parse(createOperationId());
      if (this.#dependencies.store.readOperation(operationId) !== null) {
        throw new TokenCatalogOperationError("state_conflict");
      }
      const target = this.#resolveTarget(input.account);
      if (input.asset.chainId !== target.account.chainId) {
        throw new TokenCatalogOperationError("invalid_input");
      }
      const previous = this.#dependencies.store.getSelection(target.account, input.asset)?.selection ?? null;
      const selectionSetRevision =
        this.#dependencies.store.getSelectionState(target.account)?.revision ?? null;

      let review: TokenSelectionReview;
      if (input.kind === "add") {
        if (previous?.included === true) {
          throw new TokenCatalogOperationError("token_selection_already_included");
        }
        const snapshot = this.#readOfficialSnapshot();
        const member = findOfficialAssetMember(snapshot, input.asset.address) ?? null;
        const chainResult = await this.#dependencies.additionChainReads.inspectAndVerifyOfficial({
          asset: input.asset,
          officialMember: member,
          block: null,
        }, signal);
        if (!("inspection" in chainResult)) {
          throw new TokenCatalogOperationError(chainResult.error.code);
        }
        this.#assertReviewPrecondition(
          target,
          input.asset,
          previous,
          selectionSetRevision,
          snapshot.revision,
        );
        const projection = createTokenAdditionReviewProjection({
          inspection: chainResult.inspection,
          officialSnapshotRevision: snapshot.revision,
          officialMember: member,
          officialVerification: chainResult.officialVerification,
        });
        const createdAt = this.#now();
        const withoutDigest = {
          contractVersion: "1" as const,
          domain: "token_selection" as const,
          operationId,
          kind: input.kind,
          createdAt,
          actionExpiresAt: addUtcMilliseconds(createdAt, tokenCatalogCoordinatorPolicy.userActionMilliseconds),
          target: { account: target.account, asset: input.asset },
          decision: projection.decision,
          precondition: {
            accountTarget: target.active
              ? { kind: "active_wallet" as const, connectionRevision: target.connectionRevision }
              : { kind: "address" as const },
            previousSelection: previous,
            selectionSetRevision,
          },
          fixedEvidence: projection.fixedEvidence,
        };
        review = parseTokenSelectionReview({
          ...withoutDigest,
          reviewDigest: tokenSelectionReviewDigest(withoutDigest),
        });
      } else {
        if (previous === null) throw new TokenCatalogOperationError("token_selection_not_found");
        if (!previous.included) throw new TokenCatalogOperationError("token_selection_not_included");
        if (previous.revision !== input.expectedRevision) {
          throw new TokenCatalogOperationError("token_selection_revision_changed");
        }
        if (selectionSetRevision === null) throw new TokenCatalogOperationError("internal_error");
        this.#assertReviewPrecondition(
          target,
          input.asset,
          previous,
          selectionSetRevision,
          null,
        );
        const createdAt = this.#now();
        const withoutDigest = {
          contractVersion: "1" as const,
          domain: "token_selection" as const,
          operationId,
          kind: input.kind,
          createdAt,
          actionExpiresAt: addUtcMilliseconds(createdAt, tokenCatalogCoordinatorPolicy.userActionMilliseconds),
          target: { account: target.account, asset: input.asset },
          decision: { action: "remove_selection" as const },
          precondition: {
            accountTarget: target.active
              ? { kind: "active_wallet" as const, connectionRevision: target.connectionRevision }
              : { kind: "address" as const },
            previousSelection: previous,
            selectionSetRevision,
          },
          fixedEvidence: {},
        };
        review = parseTokenSelectionReview({
          ...withoutDigest,
          reviewDigest: tokenSelectionReviewDigest(withoutDigest),
        });
      }
      return tokenCatalogApplicationContracts.selectionChangeReview.parseBoundSuccess(
        input,
        { operationId },
        { review },
      );
    });
  }

  decide(inputValue: TokenSelectionDirectAction): Promise<TokenCatalogOperation> {
    return this.#run(async (signal) => {
      const input = tokenSelectionDirectActionSchema.parse(inputValue);
      const contract = input.review.kind === "add"
        ? tokenCatalogApplicationContracts.addSelection
        : tokenCatalogApplicationContracts.removeSelection;
      const action = contract.parseInput(input);
      const existing = this.#dependencies.store.readOperation(action.review.operationId);
      if (existing !== null) {
        if (
          existing.kind !== action.review.kind ||
          !sameReview(existing.review, action.review)
        ) throw new TokenCatalogOperationError("state_conflict");
        return contract.parsePublicSuccess(action as never, existing as never) as TokenCatalogOperation;
      }
      if (Date.parse(action.review.actionExpiresAt) <= Date.parse(this.#now())) {
        throw new TokenCatalogOperationError("token_review_expired");
      }
      const decisionTarget = this.#assertAccountTargetPrecondition(action.review);
      this.#assertSelectionPrecondition(action.review);

      let inspection: TokenInspectionSuccess | null = null;
      let officialVerification: Parameters<
        TokenCatalogCoordinatorDependencies["store"]["applySelectionChange"]
      >[0]["officialVerification"] = null;
      if (action.review.kind === "add") {
        const snapshot = this.#readOfficialSnapshot(action.review.fixedEvidence.officialSnapshotRevision);
        const member = this.#reviewedOfficialMember(action.review, snapshot);
        const chainResult = await this.#dependencies.additionChainReads.inspectAndVerifyOfficial({
          asset: action.review.target.asset,
          officialMember: member,
          block: action.review.fixedEvidence.inspectionBlock,
        }, signal);
        if (!("inspection" in chainResult)) {
          throw new TokenCatalogOperationError(chainResult.error.code);
        }
        const projection = createTokenAdditionReviewProjection({
          inspection: chainResult.inspection,
          officialSnapshotRevision: snapshot.revision,
          officialMember: member,
          officialVerification: chainResult.officialVerification,
        });
        if (
          canonicalJsonStringify(projection as unknown as CanonicalJson) !==
            canonicalJsonStringify({
              decision: action.review.decision,
              fixedEvidence: action.review.fixedEvidence,
            } as unknown as CanonicalJson)
        ) throw new TokenCatalogOperationError("state_conflict");
        inspection = chainResult.inspection;
        officialVerification = chainResult.officialVerification;
        this.#assertOfficialSnapshot(action.review.fixedEvidence.officialSnapshotRevision);
      }

      this.#assertAccountTargetPrecondition(action.review, decisionTarget);
      this.#assertSelectionPrecondition(action.review);
      const operation = this.#dependencies.store.applySelectionChange({
        action,
        selectionRevision: createSelectionRevision(),
        selectionSetRevision: createSelectionSetRevision(),
        inspection,
        officialVerification,
        completedAt: this.#now(),
      });
      return contract.parsePublicSuccess(action as never, operation as never) as TokenCatalogOperation;
    });
  }

  getOperation(operationIdValue: TokenCatalogOperation["operationId"]): TokenCatalogOperation {
    this.#assertOpen();
    const operationId = tokenCatalogOperationIdSchema.parse(operationIdValue);
    const operation = this.#dependencies.store.readOperation(operationId);
    if (operation === null) throw new TokenCatalogOperationError("token_operation_not_found");
    return tokenCatalogApplicationContracts.operation.parsePublicSuccess(
      { operationId },
      operation,
    );
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    let resolveClose!: () => void;
    let rejectClose!: (reason: unknown) => void;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.#closePromise = closePromise;
    this.#lifecycleState = "closing";
    const controllers = [...this.#controllers];
    const activeCalls = [...this.#activeCalls];
    void (async (): Promise<void> => {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(activeCalls);
      this.#controllers.clear();
      this.#lifecycleState = "closed";
    })().then(resolveClose, rejectClose);
    return closePromise;
  }

  #run<Result>(operation: (signal: AbortSignal) => Promise<Result>): Promise<Result> {
    try { this.#assertOpen(); }
    catch (error) { return Promise.reject(error); }
    const controller = new AbortController();
    this.#controllers.add(controller);
    const signal = AbortSignal.any([this.#dependencies.signal, controller.signal]);
    const active = Promise.resolve().then(() => operation(signal)).catch((error) => {
      throw normalizeTokenCatalogError(error);
    });
    let settlement!: Promise<void>;
    settlement = active.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.#controllers.delete(controller);
      this.#activeCalls.delete(settlement);
    });
    this.#activeCalls.add(settlement);
    return active;
  }

  #assertOpen(): void {
    if (this.#lifecycleState !== "open") {
      throw new TokenCatalogOperationError("runtime_state_unavailable");
    }
  }

  #now(): UtcTimestamp {
    return this.#dependencies.clock.now();
  }

  #resolveTarget(
    target: TokenSelectionReviewRequest["account"],
  ): ResolvedAddressTarget {
    return requireAvailableAddressTarget(this.#dependencies.addressTargets.resolve(target));
  }

  #assertAccountTargetPrecondition(
    review: TokenSelectionReview,
    initial?: ResolvedAddressTarget | null,
  ): ResolvedAddressTarget | null {
    const expected = review.precondition.accountTarget;
    if (expected.kind === "address") return null;
    try {
      const current = this.#resolveTarget({ kind: "active_wallet" });
      if (
        !sameEvmAccountIdentity(current.account, review.target.account) ||
        !current.active ||
        current.connectionRevision !== expected.connectionRevision ||
        (initial !== undefined && initial !== null &&
          !sameResolvedAddressTarget(initial, current))
      ) throw new TokenCatalogOperationError("state_conflict");
      return current;
    } catch {
      throw new TokenCatalogOperationError("state_conflict");
    }
  }

  #assertSelectionPrecondition(review: TokenSelectionReview): void {
    const current = this.#dependencies.store.getSelection(
      review.target.account,
      review.target.asset,
    )?.selection ?? null;
    const stateRevision = this.#dependencies.store.getSelectionState(
      review.target.account,
    )?.revision ?? null;
    if (
      !sameSelection(current, review.precondition.previousSelection) ||
      stateRevision !== review.precondition.selectionSetRevision
    ) throw new TokenCatalogOperationError("token_selection_revision_changed");
  }

  #assertReviewPrecondition(
    target: ResolvedAddressTarget,
    asset: TokenSelection["asset"],
    previous: TokenSelection | null,
    selectionSetRevision: TokenSelectionReview["precondition"]["selectionSetRevision"],
    officialSnapshotRevision: string | null,
  ): void {
    if (target.active) {
      const currentTarget = this.#resolveTarget(target.target);
      if (!sameResolvedAddressTarget(target, currentTarget)) {
        throw new TokenCatalogOperationError("state_conflict");
      }
    }
    const currentSelection = this.#dependencies.store.getSelection(
      target.account,
      asset,
    )?.selection ?? null;
    const currentStateRevision = this.#dependencies.store.getSelectionState(target.account)?.revision ?? null;
    if (
      !sameSelection(currentSelection, previous) ||
      currentStateRevision !== selectionSetRevision
    ) throw new TokenCatalogOperationError("state_conflict");
    if (officialSnapshotRevision !== null) this.#assertOfficialSnapshot(officialSnapshotRevision);
  }

  #readOfficialSnapshot(expectedRevision?: string): CommittedOfficialAssetSnapshot {
    const snapshot = this.#dependencies.officialAssets.readStored();
    if (snapshot === undefined) throw new TokenCatalogOperationError("runtime_state_unavailable");
    if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) {
      throw new TokenCatalogOperationError("state_conflict");
    }
    return snapshot;
  }

  #assertOfficialSnapshot(expectedRevision: string): void {
    this.#readOfficialSnapshot(expectedRevision);
  }

  #reviewedOfficialMember(
    review: Extract<TokenSelectionReview, { readonly kind: "add" }>,
    snapshot: CommittedOfficialAssetSnapshot,
  ): OfficialAssetSourceMember | null {
    const member = findOfficialAssetMember(snapshot, review.target.asset.address) ?? null;
    const evidence = review.fixedEvidence.officialEvidence;
    if (
      (member === null) !== (evidence === null) ||
      (member !== null && evidence !== null && member.assetUid !== evidence.assetUid)
    ) throw new TokenCatalogOperationError("state_conflict");
    return member;
  }
}
