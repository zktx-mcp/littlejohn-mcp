import type {PreparedReviewDispatch} from "./prepared-dispatch.js";
import {productChainId} from "../registry/client.js";
import type {WalletBoundAccountReference} from "../wallet/bound-account-contract.js";
import {walletAccountPermissions} from "../wallet/account-admission.js";
import {addUtcMilliseconds, canonicalSha256, canonicalJsonStringify, captureCanonicalJson, deepFreezeValue, operationIdSchema, type CanonicalClock} from "../core/index.js";
import {sameEvmAccountIdentity} from "../evm/identities.js";
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
import { SigningError, signingFailureCode } from "./signing-errors.js";
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
  readonly connectionId: WalletBoundAccountReference["connectionId"];
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
    const current = await this.#session(method, signal);
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
        payload: command.payload, createdAt, actionExpiresAt, permission: current.permission,
      }));
      signingDirectDecisionSchema.parse({ review, initiatedBy: "mcp_app" });
      await this.#assertCurrent(review, signal);
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

  async confirm(input: SigningDirectDecision, signal: AbortSignal): Promise<SigningCompletion> {
    const prepared = await this.prepareConfirm(input, signal);
    try { return await prepared.execute(); } finally { prepared.discard(); }
  }

  async prepareConfirm(input: SigningDirectDecision, signal: AbortSignal): Promise<PreparedReviewDispatch<SigningCompletion>> {
    this.#assertOpen(signal);
    const decision = deepFreezeValue(signingDirectDecisionSchema.parse(captureCanonicalJson(input)));
    const review = decision.review;
    const material = this.dependencies.materials.read(review.operationId);
    if (material?.kind !== "signing" || canonicalJsonStringify(captureCanonicalJson(material.review)) !==
        canonicalJsonStringify(captureCanonicalJson(review))) throw new SigningError("review_unavailable");
    try {
      await this.#assertCurrent(review, signal);
      if (hashSigningPayload(this.dependencies.codec, material.review.payload) !== review.messageHash) {
        this.dependencies.materials.discardUnprepared(material);
        throw new SigningError("state_conflict");
      }
      const grant = Object.freeze({ operation: "signature_request", context: signingResponseContext(review), initiatedBy: decision.initiatedBy,
        expiresAt: [review.actionExpiresAt, addUtcMilliseconds(this.dependencies.clock.now(), requestReviewLimits.grantLifetimeMilliseconds)].sort()[0]! });
      await this.#assertCurrent(review, signal);
      if (this.dependencies.wallet.hasPendingRequest()) throw new SigningError("state_conflict");
      if (this.dependencies.clock.now() >= grant.expiresAt) throw new SigningError("review_expired");
      let preparedMaterial: import("./material-port.js").PreparedRequestMaterial | undefined = this.dependencies.materials.prepareConsumption(review, grant.expiresAt);
      const source = Object.freeze({kind: "signing" as const, operationId: review.operationId, resultDigest: canonicalSha256(captureCanonicalJson(review))});
      const authority = Object.freeze({context: grant.context, expiresAt: review.actionExpiresAt, connectionId: review.permission.connectionId});
      let handoff: Readonly<{permission: WalletBoundAccountReference; expiresAt: string}> | undefined =
        Object.freeze({permission: review.permission, expiresAt: grant.expiresAt});
      let used = false;
      return Object.freeze({source,
        execute: (): Promise<SigningCompletion> => {
          if (used || preparedMaterial === undefined || handoff === undefined) throw new SigningError("state_conflict");
          used = true;
          const token = preparedMaterial;
          const send = handoff;
          preparedMaterial = undefined;
          handoff = undefined;
          let attempt: Promise<WalletRequestAttempt>;
          try {
            this.#assertOpen(signal);
            this.dependencies.activeWallet.assertBoundAccountCurrent(send.permission);
            if (this.dependencies.clock.now() >= send.expiresAt) throw new SigningError("review_expired");
            const consumed = this.dependencies.materials.takePrepared(token);
            if (consumed.kind !== "signing") throw new SigningError("state_conflict");
            attempt = this.dependencies.wallet.startRequest({...consumed, sessionSourceId: authority.connectionId, sendExpiresAt: send.expiresAt});
          } catch {
            this.dependencies.materials.discardPrepared(token);
            return Promise.resolve(createSigningCompletion(authority.context, "not_sent"));
          }
          return this.#observe(attempt, authority, signal);
        },
        discard: (): void => {
          if (preparedMaterial !== undefined) this.dependencies.materials.discardPrepared(preparedMaterial);
          preparedMaterial = undefined;
          handoff = undefined;
          used = true;
        },
      });
    } catch (error) {
      const code = signingFailureCode(error);
      if (!this.#closed && code !== undefined &&
          ["review_expired", "wallet_not_connected", "wallet_session_unusable", "wallet_account_unavailable"].includes(code)) {
        this.dependencies.materials.discardUnprepared(material);
      }
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
      const current = async (): Promise<boolean> => {
        if (!waiting) return false;
        try {
          await this.#assertAuthority(authority, signal);
          return !controller.signal.aborted;
        } catch { unknown(); return false; }
      };
      timer = setTimeout(unknown, Math.max(0, Date.parse(authority.expiresAt) - Date.parse(this.dependencies.clock.now())));
      timer.unref();
      signal.addEventListener("abort", unknown, { once: true });
      controller.signal.addEventListener("abort", unknown, { once: true });
      if (signal.aborted || this.#closed) unknown();
      const receive = async (response: Awaited<WalletRequestAttempt["response"]>): Promise<void> => {
        if (!await current()) return;
        if (response.status === "signature_returned") {
          const status = await verifyDataSignature(this.dependencies.codec, authority.context.account, authority.context.messageHash, response.signature);
          if (!await current()) return;
          const result = createSigningCompletion(authority.context, status, status === "verified" ? response.signature : undefined);
          if (await current()) finish(result);
        } else {
          const status = response.status === "hash_returned" ? "delivery_unknown" : response.status;
          const result = createSigningCompletion(authority.context, status);
          if (await current()) finish(result);
        }
      };
      void attempt.then((value) => value.response.then(receive, unknown),
        async () => { if (await current()) finish(createSigningCompletion(authority.context, "not_sent")); }).catch(unknown);
    });
  }

  async #session(method: SigningResponseContext["method"], signal?: AbortSignal) {
    const value = await this.dependencies.activeWallet.resolveAccount({chainId: productChainId, requiredMethods: [method]}, signal);
    this.#assertOpen(signal);
    return {account: value.account, permission: value.permission, expiresAt: value.connection.expiresAt};
  }
  async #assertAuthority(authority: ResponseAuthority, signal: AbortSignal) {
    this.#assertOpen(signal);
    const current = await this.dependencies.activeWallet.capture(signal);
    this.#assertOpen(signal);
    if (current.connection.status !== "connected" || current.sessionSource?.sourceId !== authority.connectionId ||
        current.connection.connectionId !== authority.connectionId) throw new SigningError("wallet_session_unusable");
    if (this.dependencies.clock.now() >= authority.expiresAt || this.dependencies.clock.now() >= current.connection.expiresAt) throw new SigningError("review_expired");
    const permission = walletAccountPermissions(current.connection.namespaces, authority.context.account.chainId)
      .find((entry) => sameEvmAccountIdentity(entry.account, authority.context.account));
    if (permission === undefined || !permission.methods.includes(authority.context.method)) throw new SigningError("wallet_session_unusable");
  }
  async #assertCurrent(review: SigningReview, signal: AbortSignal): Promise<void> {
    this.#assertOpen(signal);
    const current = await this.dependencies.activeWallet.validateBoundAccount(review.permission, signal);
    this.#assertOpen(signal);
    if (this.dependencies.clock.now() >= review.actionExpiresAt || this.dependencies.clock.now() >= current.connection.expiresAt) throw new SigningError("review_expired");
    if (!sameEvmAccountIdentity(current.account, review.account)) throw new SigningError("wallet_session_unusable");
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
