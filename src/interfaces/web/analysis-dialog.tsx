import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  contractInspectCapability,
  evmAddressSchema,
  getCapabilityDefinitionSnapshot,
  hash32Schema,
  productChainId,
  unsignedDecimalSchema,
  type CapabilitySuccess,
  type ContractInspectData,
  type EvmAddress,
} from "../../core/browser.js";
import type {
  TokenInspectionSuccess,
} from "../../token-catalog/browser.js";
import {
  ContractControlSummary,
  ContractAnalysisDetails,
  TokenInspectionAnalysisDetails,
} from "./analysis-details.js";
import {
  invalidBrowserResponse,
  type BrowserFetch,
} from "./browser-client.js";
import { CopyableIdentifier } from "./copyable-identifier.js";
import {
  humanFailureText,
  presentBrowserRequestFailure,
  type HumanFailurePresentation,
} from "./human-failures.js";
import { LoadingIndicator } from "./loading-indicator.js";
import { inspectContract } from "./contract-inspection-client.js";
import { createBrowserRequestAuthority } from "./request-authority.js";
import { inspectTokenContract } from "./token-catalog-client.js";

export type AnalysisTargetKind = "contract" | "token";

export interface AnalysisTarget {
  readonly kind: AnalysisTargetKind;
  readonly address: EvmAddress;
  readonly blockNumber?: string;
  readonly expectedBlockHash?: string;
}

export const createAnalysisTarget = (input: Readonly<{
  kind: unknown;
  address: unknown;
  blockNumber?: unknown;
  expectedBlockHash?: unknown;
}>): AnalysisTarget => {
  if (input.kind !== "contract" && input.kind !== "token") {
    throw new TypeError("Analysis target kind is invalid.");
  }
  const blockNumber = input.blockNumber === undefined
    ? undefined
    : unsignedDecimalSchema.parse(input.blockNumber);
  const expectedBlockHash = input.expectedBlockHash === undefined
    ? undefined
    : hash32Schema.parse(input.expectedBlockHash);
  if (expectedBlockHash !== undefined && blockNumber === undefined) {
    throw new TypeError("Expected block hash requires an exact block number.");
  }
  return Object.freeze({
    kind: input.kind,
    address: evmAddressSchema.parse(input.address),
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(expectedBlockHash === undefined ? {} : { expectedBlockHash }),
  });
};

type AnalysisResult =
  | Readonly<{
      kind: "contract";
      result: CapabilitySuccess<ContractInspectData>;
    }>
  | Readonly<{
      kind: "token";
      result: TokenInspectionSuccess;
    }>;

type AnalysisState =
  | Readonly<{ targetKey: string; status: "loading" }>
  | Readonly<{
      targetKey: string;
      status: "error";
      failure: HumanFailurePresentation;
    }>
  | Readonly<{ targetKey: string; status: "block_mismatch" }>
  | Readonly<{
      targetKey: string;
      status: "available";
      value: AnalysisResult;
    }>;

const contractLimitations =
  getCapabilityDefinitionSnapshot(contractInspectCapability).staticScopeExclusions;

const analysisBlock = (value: AnalysisResult) =>
  value.result.data.analysis.block;

const analysisTargetKey = (target: AnalysisTarget): string =>
  [
    target.kind,
    target.address,
    target.blockNumber ?? "latest",
    target.expectedBlockHash ?? "",
  ].join(":");

const analysisResultMatchesTarget = (
  value: AnalysisResult,
  target: AnalysisTarget,
): boolean =>
  value.kind === target.kind &&
  value.result.data.analysis.target === target.address &&
  (target.blockNumber === undefined ||
    analysisBlock(value).blockNumber === target.blockNumber);

const AnalysisResultView = ({ value }: { readonly value: AnalysisResult }) =>
  value.kind === "contract" ? (
    <ContractAnalysisDetails
      analysis={value.result.data.analysis}
      coverage={value.result.evidence.coverage}
      warnings={value.result.warnings}
      limitations={contractLimitations}
    />
  ) : (
    <TokenInspectionAnalysisDetails inspection={value.result} />
  );

export interface AnalysisDialogContentProps {
  readonly target: AnalysisTarget;
  readonly recoverSession: (error: unknown) => boolean;
  readonly request?: BrowserFetch;
}

const useAnalysisRead = ({
  target,
  recoverSession,
  request,
}: AnalysisDialogContentProps) => {
  const [authority] = useState(createBrowserRequestAuthority);
  const currentTargetKey = analysisTargetKey(target);
  const [readState, setReadState] = useState<AnalysisState>({
    targetKey: currentTargetKey,
    status: "loading",
  });
  const targetRef = useRef(target);
  targetRef.current = target;
  const recoverSessionRef = useRef(recoverSession);
  recoverSessionRef.current = recoverSession;
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    authority.activate();
    return () => { authority.close(); };
  }, [authority]);

  const readAnalysis = useCallback(async (
    boundTarget: AnalysisTarget = targetRef.current,
  ): Promise<void> => {
    const active = authority.beginRead();
    if (active === undefined) return;
    const targetKey = analysisTargetKey(boundTarget);
    setReadState({ targetKey, status: "loading" });
    const block = boundTarget.blockNumber === undefined
      ? { kind: "latest" as const }
      : { kind: "number" as const, blockNumber: boundTarget.blockNumber };
    try {
      const currentRequest = requestRef.current;
      const value: AnalysisResult = boundTarget.kind === "contract"
        ? Object.freeze({
            kind: boundTarget.kind,
            result: await inspectContract(
              { address: boundTarget.address, block },
              {
                ...(currentRequest === undefined
                  ? {}
                  : { request: currentRequest }),
                signal: active.signal,
              },
            ),
          })
        : Object.freeze({
            kind: boundTarget.kind,
            result: await inspectTokenContract(
              {
                asset: {
                  kind: "erc20",
                  chainId: productChainId,
                  address: boundTarget.address,
                },
                block,
              },
              {
                ...(currentRequest === undefined
                  ? {}
                  : { request: currentRequest }),
                signal: active.signal,
              },
            ),
          });
      if (!authority.isCurrent(active)) return;
      if (!analysisResultMatchesTarget(value, boundTarget)) {
        setReadState({
          targetKey,
          status: "error",
          failure: presentBrowserRequestFailure(
            "analysis",
            invalidBrowserResponse(),
          ),
        });
        return;
      }
      if (
        boundTarget.expectedBlockHash !== undefined &&
        analysisBlock(value).blockHash !== boundTarget.expectedBlockHash
      ) {
        setReadState({
          targetKey,
          status: "block_mismatch",
        });
        return;
      }
      setReadState({ targetKey, status: "available", value });
    } catch (error) {
      if (
        !authority.isCurrent(active) ||
        recoverSessionRef.current(error)
      ) {
        return;
      }
      setReadState({
        targetKey,
        status: "error",
        failure: presentBrowserRequestFailure("analysis", error),
      });
    } finally {
      if (authority.isCurrent(active)) authority.cancelRead(active);
    }
  }, [authority]);

  useEffect(() => {
    authority.invalidateRead();
    void readAnalysis(targetRef.current);
  }, [
    authority,
    readAnalysis,
    target.address,
    target.blockNumber,
    target.expectedBlockHash,
    target.kind,
  ]);

  const state: AnalysisState =
    readState.targetKey === currentTargetKey
      ? readState
      : Object.freeze({
          targetKey: currentTargetKey,
          status: "loading",
        });
  return Object.freeze({
    state,
    retry: () => { void readAnalysis(); },
  });
};

const AnalysisReadFailure = ({
  state,
  onRetry,
}: {
  readonly state: Extract<
    AnalysisState,
    { status: "error" | "block_mismatch" }
  >;
  readonly onRetry: () => void;
}) => (
  <div className="error" role="alert">
    <p>
      {state.status === "block_mismatch"
        ? "The analysis result did not match the exact originating block hash."
        : humanFailureText(state.failure)}
    </p>
    {state.status === "error" && state.failure.retryable ? (
      <button
        type="button"
        className="secondary"
        onClick={onRetry}
      >
        Retry
      </button>
    ) : null}
  </div>
);

export const TokenControlSummary = ({
  target,
  recoverSession,
  request,
}: AnalysisDialogContentProps) => {
  const { state, retry } = useAnalysisRead({
    target,
    recoverSession,
    ...(request === undefined ? {} : { request }),
  });

  if (state.status === "available" && state.value.kind === "token") {
    return (
      <ContractControlSummary
        analysis={state.value.result.data.analysis}
        coverage={state.value.result.evidence.coverage}
      />
    );
  }

  return (
    <section
      className="analysis-control-summary"
      aria-labelledby="analysis-control-summary-heading"
    >
      <h2 id="analysis-control-summary-heading">Control summary</h2>
      {state.status === "loading" ? (
        <LoadingIndicator label="Reading control summary" />
      ) : state.status === "available" ? (
        <div className="error" role="alert">
          <p>The token control summary could not be matched to its target.</p>
        </div>
      ) : (
        <AnalysisReadFailure state={state} onRetry={retry} />
      )}
    </section>
  );
};

export const AnalysisDialogContent = ({
  target,
  recoverSession,
  request,
}: AnalysisDialogContentProps) => {
  const { state, retry } = useAnalysisRead({
    target,
    recoverSession,
    ...(request === undefined ? {} : { request }),
  });

  return (
    <div className="analysis-dialog-content">
      {state.status === "loading" ? (
        <LoadingIndicator label="Reading analysis" />
      ) : state.status === "error" || state.status === "block_mismatch" ? (
        <AnalysisReadFailure state={state} onRetry={retry} />
      ) : (
        <AnalysisResultView value={state.value} />
      )}
      <section
        className="analysis-target"
        aria-labelledby="analysis-target-heading"
      >
        <h2 id="analysis-target-heading">
          {target.kind === "token"
            ? "Originating token target"
            : "Originating contract target"}
        </h2>
        <CopyableIdentifier
          label={`${target.kind} analysis target address`}
          value={target.address}
        />
        <dl className="analysis-target-block">
          <dt>Requested block</dt>
          <dd>{target.blockNumber ?? "Latest block"}</dd>
        </dl>
      </section>
    </div>
  );
};
