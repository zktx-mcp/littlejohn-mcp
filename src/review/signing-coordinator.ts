import {
  addUtcMilliseconds, canonicalJsonStringify, captureCanonicalJson, deepFreezeValue,
  evmAccountIdentitySchema, operationIdSchema, sameEvmAccountIdentity, walletConnectionDataSchema,
  type CanonicalClock,
} from "../core/index.js";
import type { SigningCodec } from "../chain/signing-port.js";
import { verifyDataSignature } from "../intelligence/signature-verification.js";
import { createOperationId } from "../runtime/operation-id.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import type { WalletRequestPort, WalletRequestAttempt } from "../wallet/request-contract.js";
import type { RequestReviewMaterialStore } from "./material-port.js";
import {
  signingCommandSchema, signingReviewSchema, signingDirectDecisionSchema, signingResponseContext,
  createSigningCompletion, type SigningCommand, type SigningReview, type SigningDirectDecision,
  type SigningCompletion, type SigningResponseContext,
} from "./signing-contracts.js";
import { signingMethod } from "./signing-payload.js";
import { hashSigningPayload } from "./signing-hash.js";
import { SigningError } from "./signing-errors.js";
import { requestReviewLimits } from "./request-limits.js";

interface SigningDependencies {
  readonly clock: CanonicalClock;
  readonly activeWallet: ActiveWalletReadPort;
  readonly codec: SigningCodec;
  readonly materials: RequestReviewMaterialStore;
  readonly wallet: WalletRequestPort;
}
interface ResponseAuthority {
  readonly context: SigningResponseContext;
  readonly sessionSourceId: string;
  readonly expiresAt: string;
}

export class SigningCoordinator {
  readonly #waiting = new Set<AbortController>();
  #closed = false;
  constructor(private readonly dependencies: SigningDependencies) {}

  async start(input: SigningCommand, signal: AbortSignal): Promise<SigningReview> {
    this.#assertOpen(signal);
    const command = deepFreezeValue(signingCommandSchema.parse(captureCanonicalJson(input)));
    const method = signingMethod(command.payload);
    const current = this.#session(method);
    if (command.account.kind === "address" && command.account.address !== current.account.address) throw new SigningError("wallet_session_unusable");
    const createdAt = this.dependencies.clock.now();
    const actionExpiresAt = [current.expiresAt, addUtcMilliseconds(createdAt, requestReviewLimits.reviewLifetimeMilliseconds)].sort()[0]!;
    const operationId = createOperationId();
    const slot = this.dependencies.materials.reserve(operationId, createdAt, actionExpiresAt);
    let published = false;
    try {
      const review = deepFreezeValue(signingReviewSchema.parse({
        contractVersion: "1", state: "ready_for_wallet_review", operationId,
        account: current.account, method, messageHash: hashSigningPayload(this.dependencies.codec, command.payload),
        payload: command.payload, createdAt, actionExpiresAt, sessionSourceId: current.sessionSourceId,
        connectionRevision: current.connectionRevision,
      }));
      signingDirectDecisionSchema.parse({ review, initiatedBy: "mcp_app" });
      this.#assertCurrent(review, signal);
      this.dependencies.materials.publish(slot, { kind: "signing", review, command });
      published = true;
      return review;
    } finally { if (!published) this.dependencies.materials.release(slot); }
  }

  get(operationId: string): SigningReview | null {
    this.#assertOpen();
    const value = this.dependencies.materials.read(operationIdSchema.parse(operationId));
    return value?.kind === "signing" ? value.review : null;
  }
  cancel(operationId: string) {
    const id = operationIdSchema.parse(operationId);
    if (this.get(id) === null) return Object.freeze({ operationId: id, status: "unavailable" as const });
    this.dependencies.materials.discard(id);
    return Object.freeze({ operationId: id, status: "discarded" as const });
  }

  confirm(input: SigningDirectDecision, signal: AbortSignal): Promise<SigningCompletion> {
    this.#assertOpen(signal);
    const decision = deepFreezeValue(signingDirectDecisionSchema.parse(captureCanonicalJson(input)));
    const review = decision.review;
    const material = this.dependencies.materials.read(review.operationId);
    if (material?.kind !== "signing" || canonicalJsonStringify(captureCanonicalJson(material.review)) !==
        canonicalJsonStringify(captureCanonicalJson(review))) throw new SigningError("review_unavailable");
    try {
      this.#assertCurrent(review, signal);
      if (hashSigningPayload(this.dependencies.codec, material.review.payload) !== review.messageHash) throw new SigningError("state_conflict");
      const grant = Object.freeze({ operation: "signature_request", context: signingResponseContext(review), initiatedBy: decision.initiatedBy,
        expiresAt: [review.actionExpiresAt, addUtcMilliseconds(this.dependencies.clock.now(), requestReviewLimits.grantLifetimeMilliseconds)].sort()[0]! });
      this.#assertCurrent(review, signal);
      if (this.dependencies.wallet.hasPendingRequest()) throw new SigningError("state_conflict");
      if (this.dependencies.clock.now() >= grant.expiresAt) throw new SigningError("review_expired");
      const consumed = this.dependencies.materials.consume(review);
      if (consumed.kind !== "signing") throw new SigningError("state_conflict");
      let attempt: Promise<WalletRequestAttempt>;
      try { attempt = this.dependencies.wallet.startRequest({ ...consumed, sessionSourceId: review.sessionSourceId, sendExpiresAt: grant.expiresAt }); }
      catch { return Promise.resolve(createSigningCompletion(grant.context, "not_sent")); }
      // This continuation receives no Review, payload, grant or sender.
      return this.#observe(attempt, { context: grant.context, expiresAt: review.actionExpiresAt,
        sessionSourceId: review.sessionSourceId }, signal);
    } catch (error) {
      this.dependencies.materials.discard(review.operationId);
      throw error;
    }
  }

  #observe(attempt: Promise<WalletRequestAttempt>, authority: ResponseAuthority, signal: AbortSignal): Promise<SigningCompletion> {
    const controller = new AbortController();
    this.#waiting.add(controller);
    return new Promise((resolve) => {
      let waiting = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (completion: SigningCompletion): void => {
        if (!waiting) return;
        waiting = false;
        clearTimeout(timer);
        signal.removeEventListener("abort", unknown);
        controller.signal.removeEventListener("abort", unknown);
        this.#waiting.delete(controller);
        resolve(completion);
      };
      const unknown = (): void => finish(createSigningCompletion(authority.context, "delivery_unknown"));
      const current = (): boolean => {
        if (!waiting) return false;
        try {
          this.#assertAuthority(authority, signal);
          return !controller.signal.aborted;
        } catch { unknown(); return false; }
      };
      timer = setTimeout(unknown, Math.max(0, Date.parse(authority.expiresAt) - Date.parse(this.dependencies.clock.now())));
      timer.unref();
      signal.addEventListener("abort", unknown, { once: true });
      controller.signal.addEventListener("abort", unknown, { once: true });
      if (signal.aborted || this.#closed) unknown();
      const receive = async (response: Awaited<WalletRequestAttempt["response"]>): Promise<void> => {
        if (!current()) return;
        if (response.status === "signature_returned") {
          const status = await verifyDataSignature(this.dependencies.codec, authority.context.account, authority.context.messageHash, response.signature);
          if (!current()) return;
          const result = createSigningCompletion(authority.context, status, status === "verified" ? response.signature : undefined);
          if (current()) finish(result);
        } else {
          const status = response.status === "hash_returned" ? "delivery_unknown" : response.status;
          const result = createSigningCompletion(authority.context, status);
          if (current()) finish(result);
        }
      };
      void attempt.then((value) => value.response.then(receive, unknown),
        () => { if (current()) finish(createSigningCompletion(authority.context, "not_sent")); }).catch(unknown);
    });
  }

  #session(method: SigningResponseContext["method"]) {
    const value = this.dependencies.activeWallet.capture();
    const connection = walletConnectionDataSchema.parse(value.connection);
    if (connection.status !== "connected" || value.sessionSource === undefined) throw new SigningError("wallet_not_connected");
    if (!connection.approvedMethods.some((approved) => approved === method)) throw new SigningError("wallet_session_unusable");
    return { account: evmAccountIdentitySchema.parse({ chainId: connection.chainId, address: connection.address }),
      sessionSourceId: value.sessionSource.sourceId, connectionRevision: value.connectionRevision, expiresAt: connection.expiresAt };
  }
  #assertAuthority(authority: ResponseAuthority, signal: AbortSignal) {
    this.#assertOpen(signal);
    const current = this.#session(authority.context.method);
    if (this.dependencies.clock.now() >= authority.expiresAt || this.dependencies.clock.now() >= current.expiresAt) throw new SigningError("review_expired");
    if (!sameEvmAccountIdentity(current.account, authority.context.account) || current.sessionSourceId !== authority.sessionSourceId) throw new SigningError("wallet_session_unusable");
    return current;
  }
  #assertCurrent(review: SigningReview, signal: AbortSignal): void {
    const current = this.#assertAuthority({ context: signingResponseContext(review), expiresAt: review.actionExpiresAt,
      sessionSourceId: review.sessionSourceId }, signal);
    if (current.connectionRevision !== review.connectionRevision) throw new SigningError("wallet_session_unusable");
  }
  #assertOpen(signal?: AbortSignal): void {
    if (this.#closed) throw new SigningError("runtime_state_unavailable");
    if (signal?.aborted) throw new SigningError("request_aborted");
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#waiting) controller.abort();
  }
}
