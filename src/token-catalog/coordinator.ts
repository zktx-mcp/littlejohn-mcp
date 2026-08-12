import { randomBytes } from "node:crypto";

import {
  ObservationAuthorityRegistry,
  canonicalJsonStringify,
  parseUtcTimestamp,
  type CanonicalClock,
  type CanonicalJson,
  type EvmAccountIdentity,
  type OperationId,
  type UnsignedDecimal,
  type UtcTimestamp,
} from "../core/index.js";
import {
  findOfficialAssetMember,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSourceMember,
} from "../registry/index.js";
import { createOperationId } from "../runtime/operation-id.js";
import { captureConnectedWalletSession } from "./active-wallet.js";
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

const addMilliseconds = (value: UtcTimestamp, milliseconds: number): UtcTimestamp =>
  parseUtcTimestamp(new Date(Date.parse(value) + milliseconds).toISOString());

const createSelectionRevision = () => tokenSelectionRevisionSchema.parse(
  randomBytes(tokenCatalogContractLimits.selectionRevisionBytes).toString("base64url"),
);
const createSelectionSetRevision = () => tokenSelectionSetRevisionSchema.parse(
  randomBytes(tokenCatalogContractLimits.selectionRevisionBytes).toString("base64url"),
);

interface CapturedWallet {
  readonly account: EvmAccountIdentity;
  readonly connectionRevision: UnsignedDecimal;
}

export interface TokenCatalogCoordinatorRuntimeDependencies extends TokenCatalogCoordinatorDependencies {
  readonly clock: CanonicalClock;
  readonly signal: AbortSignal;
}

const sameAccount = (left: EvmAccountIdentity, right: EvmAccountIdentity): boolean =>
  left.chainId === right.chainId && left.address === right.address;

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
      const wallet = this.#captureWallet();
      if (input.asset.chainId !== wallet.account.chainId) {
        throw new TokenCatalogOperationError("invalid_input");
      }
      const previous = this.#dependencies.store.getSelection(wallet.account, input.asset)?.selection ?? null;
      const selectionSetRevision =
        this.#dependencies.store.getSelectionState(wallet.account)?.revision ?? null;

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
          wallet,
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
          actionExpiresAt: addMilliseconds(createdAt, tokenCatalogCoordinatorPolicy.userActionMilliseconds),
          target: { asset: input.asset },
          decision: projection.decision,
          precondition: {
            account: wallet.account,
            connectionRevision: wallet.connectionRevision,
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
          wallet,
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
          actionExpiresAt: addMilliseconds(createdAt, tokenCatalogCoordinatorPolicy.userActionMilliseconds),
          target: { asset: input.asset },
          decision: { action: "remove_selection" as const },
          precondition: {
            account: wallet.account,
            connectionRevision: wallet.connectionRevision,
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
      this.#assertWalletPrecondition(action.review);
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

      this.#assertWalletPrecondition(action.review);
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
    this.#lifecycleState = "closing";
    for (const controller of this.#controllers) controller.abort();
    const closePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#activeCalls]);
      this.#controllers.clear();
      this.#lifecycleState = "closed";
    });
    this.#closePromise = closePromise;
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

  #captureWallet(): CapturedWallet {
    const active = captureConnectedWalletSession(this.#dependencies.activeWallet);
    try {
      const authorities = new ObservationAuthorityRegistry(
        this.#dependencies.clock,
        [active.sessionSource.observationAuthority],
      );
      if (authorities.get("wallet_session") !== active.sessionSource.observationAuthority) {
        throw new TypeError("Active wallet evidence authority is unavailable.");
      }
    } catch {
      throw new TokenCatalogOperationError("wallet_session_unusable");
    }
    return Object.freeze({
      account: active.account,
      connectionRevision: active.connectionRevision,
    });
  }

  #assertWalletPrecondition(review: TokenSelectionReview): void {
    let current: CapturedWallet;
    try { current = this.#captureWallet(); }
    catch (error) {
      const code = normalizeTokenCatalogError(error).failure.error.code;
      if (code === "wallet_not_connected" || code === "wallet_session_unusable") {
        throw new TokenCatalogOperationError("state_conflict");
      }
      throw error;
    }
    if (
      !sameAccount(current.account, review.precondition.account) ||
      current.connectionRevision !== review.precondition.connectionRevision
    ) throw new TokenCatalogOperationError("state_conflict");
  }

  #assertSelectionPrecondition(review: TokenSelectionReview): void {
    const current = this.#dependencies.store.getSelection(
      review.precondition.account,
      review.target.asset,
    )?.selection ?? null;
    const stateRevision = this.#dependencies.store.getSelectionState(
      review.precondition.account,
    )?.revision ?? null;
    if (
      !sameSelection(current, review.precondition.previousSelection) ||
      stateRevision !== review.precondition.selectionSetRevision
    ) throw new TokenCatalogOperationError("token_selection_revision_changed");
  }

  #assertReviewPrecondition(
    wallet: CapturedWallet,
    asset: TokenSelection["asset"],
    previous: TokenSelection | null,
    selectionSetRevision: TokenSelectionReview["precondition"]["selectionSetRevision"],
    officialSnapshotRevision: string | null,
  ): void {
    const currentWallet = this.#captureWallet();
    const currentSelection = this.#dependencies.store.getSelection(
      wallet.account,
      asset,
    )?.selection ?? null;
    const currentStateRevision = this.#dependencies.store.getSelectionState(wallet.account)?.revision ?? null;
    if (
      !sameAccount(currentWallet.account, wallet.account) ||
      currentWallet.connectionRevision !== wallet.connectionRevision ||
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
