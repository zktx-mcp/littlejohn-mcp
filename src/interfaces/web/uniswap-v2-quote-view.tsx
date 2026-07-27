import {
  useEffect,
  useState,
} from "react";

import {
  getCapabilityDefinitionSnapshot,
  productChainId,
  type CapabilitySuccess,
  type EvidenceSource,
} from "../../core/browser.js";
import {
  formatUniswapV2TokenUnitPrice,
  uniswapV2FactoryAddress,
  uniswapV2QuoteCapability,
  type UniswapV2EvaluatedHop,
  type UniswapV2QuoteData,
} from "../../protocols/uniswap-v2/browser.js";
import {
  browserActionFailureMessage,
  type BrowserFetch,
} from "./browser-client.js";
import { ContractAnalysisSummary } from "./contract-inspection-view.js";
import { createBrowserRequestAuthority } from "./request-authority.js";
import { quoteUniswapV2ExactInput } from "./uniswap-v2-client.js";

type QuoteState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{ status: "available"; result: CapabilitySuccess<UniswapV2QuoteData> }>;

const limitations =
  getCapabilityDefinitionSnapshot(uniswapV2QuoteCapability).staticScopeExclusions;

const readable = (value: string): string => value.replaceAll("_", " ");

const sourceReference = (source: EvidenceSource): string => {
  switch (source.reference.kind) {
    case "public": return source.reference.uri;
    case "configured_rpc": return source.reference.publicOrigin;
    case "wallet_session": return source.reference.sourceId;
    case "wallet_sdk": return source.reference.sourceId;
    case "validated_input": return source.reference.sourceId;
  }
};

const decimalsText = (
  value: UniswapV2EvaluatedHop["tokenIn"]["decimals"],
): string => value.status === "observed"
  ? value.value
  : value.status === "unavailable"
    ? `unavailable (${readable(value.reason)})`
    : readable(value.status);

const EvaluatedHopDetails = ({
  hop,
  index,
}: {
  readonly hop: UniswapV2EvaluatedHop;
  readonly index: number;
}) => (
  <li>
    <h4>Hop {index + 1}</h4>
    <dl className="contract-analysis-fields">
      <dt>Input token</dt><dd>{hop.tokenIn.asset.address}</dd>
      <dt>Input decimals</dt><dd>{decimalsText(hop.tokenIn.decimals)}</dd>
      <dt>Output token</dt><dd>{hop.tokenOut.asset.address}</dd>
      <dt>Output decimals</dt><dd>{decimalsText(hop.tokenOut.decimals)}</dd>
      <dt>Raw input</dt><dd>{hop.amountIn}</dd>
      <dt>Factory result</dt><dd>{hop.factoryResult}</dd>
      <dt>Hop status</dt><dd>{readable(hop.status)}</dd>
      {hop.status === "pair_absent" ? null : (
        <>
          <dt>Pair address</dt><dd>{hop.pair.pairAddress}</dd>
          <dt>Pair code hash</dt><dd>{hop.pair.runtimeCode.codeHash}</dd>
          <dt>Pair code bytes</dt><dd>{hop.pair.runtimeCode.byteLength}</dd>
          <dt>Reported factory</dt><dd>{hop.pair.factory}</dd>
          <dt>Token 0</dt><dd>{hop.pair.token0}</dd>
          <dt>Token 1</dt><dd>{hop.pair.token1}</dd>
          <dt>Reserve 0</dt><dd>{hop.pair.reserve0}</dd>
          <dt>Reserve 1</dt><dd>{hop.pair.reserve1}</dd>
          <dt>Fee rate</dt>
          <dd>{hop.feeRate.numerator}/{hop.feeRate.denominator}</dd>
        </>
      )}
      {hop.status === "completed" || hop.status === "amount_too_small" ? (
        <><dt>Raw output</dt><dd>{hop.amountOut}</dd></>
      ) : null}
    </dl>
  </li>
);

export const UniswapV2QuoteResult = ({
  result,
}: {
  readonly result: CapabilitySuccess<UniswapV2QuoteData>;
}) => (
  <div className="uniswap-v2-result">
    <dl className="contract-analysis-fields">
      <dt>Protocol</dt><dd>{result.data.protocol.protocolId}</dd>
      <dt>Factory</dt><dd>{result.data.deployment.factory}</dd>
      <dt>Factory code hash</dt><dd>{result.data.deployment.runtimeCode.codeHash}</dd>
      <dt>Factory code bytes</dt><dd>{result.data.deployment.runtimeCode.byteLength}</dd>
      <dt>Pair init-code hash</dt><dd>{result.data.deployment.pairInitCodeHash}</dd>
      <dt>Canonical block</dt>
      <dd>{result.data.block.blockNumber} / {result.data.block.blockHash}</dd>
      <dt>Block timestamp</dt><dd>{result.data.block.blockTimestamp}</dd>
      <dt>Evaluated at</dt><dd>{result.meta.evaluatedAt}</dd>
      <dt>Input</dt>
      <dd>{result.data.input.amountIn} raw {result.data.input.tokenIn.address}</dd>
      <dt>Input decimals</dt><dd>{result.data.input.tokenInDecimals}</dd>
      <dt>Output token</dt><dd>{result.data.input.tokenOut.address}</dd>
      <dt>Output decimals</dt><dd>{result.data.input.tokenOutDecimals}</dd>
      <dt>Route coverage</dt><dd>{readable(result.data.coverage.basis)}</dd>
      <dt>Route assets</dt>
      <dd className="multiline-value">{result.data.coverage.routeAssets.join("\n")}</dd>
    </dl>
    <section className="analysis-section">
      <h2>Official source records</h2>
      <dl className="contract-analysis-fields">
        <dt>Deployment source</dt>
        <dd>{result.data.deployment.source.sourceOwner} — {result.data.deployment.source.sourceUri}</dd>
        <dt>Deployment source class</dt><dd>{readable(result.data.deployment.source.sourceClass)}</dd>
        <dt>Deployment revision</dt><dd>{result.data.deployment.source.sourceRevision}</dd>
        <dt>Deployment coverage</dt><dd>{readable(result.data.deployment.source.coverage)}</dd>
        <dt>Deployment supported conclusions</dt>
        <dd className="multiline-value">
          {result.data.deployment.source.supportedConclusions.join("\n")}
        </dd>
        <dt>Deployment unsupported conclusions</dt>
        <dd className="multiline-value">
          {result.data.deployment.source.unsupportedConclusions.join("\n")}
        </dd>
        <dt>Route-asset source</dt>
        <dd>{result.data.coverage.source.sourceOwner} — {result.data.coverage.source.sourceUri}</dd>
        <dt>Route source class</dt><dd>{readable(result.data.coverage.source.sourceClass)}</dd>
        <dt>Route source observed at</dt>
        <dd>{result.data.coverage.source.sourceObservedAt}</dd>
        <dt>Route source freshness</dt>
        <dd>
          {readable(result.data.coverage.source.freshnessStatus)}
          {" "}({readable(result.data.coverage.source.freshnessRule)})
        </dd>
        <dt>Route source coverage</dt><dd>{readable(result.data.coverage.source.coverage)}</dd>
        <dt>Route source supported conclusions</dt>
        <dd className="multiline-value">
          {result.data.coverage.source.supportedConclusions.join("\n")}
        </dd>
        <dt>Route source unsupported conclusions</dt>
        <dd className="multiline-value">
          {result.data.coverage.source.unsupportedConclusions.join("\n")}
        </dd>
      </dl>
    </section>
    <section className="analysis-section">
      <h2>Factory contract analysis</h2>
      <ContractAnalysisSummary
        analysis={result.data.deployment.analysis}
        coverage={result.evidence.coverage}
      />
    </section>
    <section className="analysis-section">
      <h2>Candidate results</h2>
      <div className="quote-candidates">
        {result.data.candidates.map((candidate, candidateIndex) => (
          <article
            className="quote-candidate"
            key={candidate.path.map((asset) => asset.address).join(":")}
          >
            <h3>Candidate {candidateIndex + 1}</h3>
            <code className="scrolling-text">
              {candidate.path.map((asset) => asset.address).join(" → ")}
            </code>
            <p>Status: {readable(candidate.status)}</p>
            <ul className="evaluated-hops">
              {candidate.evaluatedHops.map((hop, hopIndex) => (
                <EvaluatedHopDetails
                  hop={hop}
                  index={hopIndex}
                  key={`${hopIndex}:${hop.tokenIn.asset.address}:${hop.tokenOut.asset.address}`}
                />
              ))}
            </ul>
            {candidate.status === "quoted" ? (
              <dl>
                <dt>Expected output</dt><dd>{candidate.amountOut}</dd>
                <dt>Mid price (raw output units per raw input unit)</dt>
                <dd>{candidate.midPrice.numerator}/{candidate.midPrice.denominator}</dd>
                <dt>Mid price (output tokens per input token)</dt>
                <dd>{formatUniswapV2TokenUnitPrice(
                  candidate.midPrice,
                  result.data.input.tokenInDecimals,
                  result.data.input.tokenOutDecimals,
                )}</dd>
                <dt>Execution price (raw output units per raw input unit)</dt>
                <dd>{candidate.executionPrice.numerator}/{candidate.executionPrice.denominator}</dd>
                <dt>Execution price (output tokens per input token)</dt>
                <dd>{formatUniswapV2TokenUnitPrice(
                  candidate.executionPrice,
                  result.data.input.tokenInDecimals,
                  result.data.input.tokenOutDecimals,
                )}</dd>
                <dt>Price impact</dt>
                <dd>{candidate.priceImpact.numerator}/{candidate.priceImpact.denominator}</dd>
                <dt>SDK check</dt>
                <dd>{candidate.sdkCheck.status === "matched"
                  ? "matched"
                  : `not available (${readable(candidate.sdkCheck.reason)})`}</dd>
              </dl>
            ) : null}
          </article>
        ))}
      </div>
    </section>
    <section className="analysis-section">
      <h2>Evidence sources</h2>
      <ul className="analysis-list">
        {result.evidence.sources.map((source) => (
          <li key={source.observationId}>
            <strong>{readable(source.purpose)}</strong>
            <span>{source.owner} / {readable(source.sourceClass)}</span>
            <span>Observed at {source.observedAt}</span>
            <span className="scrolling-text">{sourceReference(source)}</span>
            <span className="scrolling-text">Record digest {source.recordDigest}</span>
            {source.chainAnchor === undefined ? null : (
              <span>
                Block {source.chainAnchor.blockNumber} / {source.chainAnchor.blockHash}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
    <section className="analysis-section">
      <h2>Evidence conclusions</h2>
      <ul className="analysis-list">
        {result.evidence.conclusions.map((conclusion) => (
          <li key={conclusion.id}>
            <strong>{conclusion.id}</strong>
            <span>{readable(conclusion.status)} / {readable(conclusion.reason)}</span>
            <span>
              Freshness: {readable(conclusion.freshness.status)}
              {" "}({readable(conclusion.freshness.ruleId)})
            </span>
          </li>
        ))}
      </ul>
      <dl className="contract-analysis-fields">
        <dt>Evidence coverage</dt><dd>{readable(result.evidence.coverage.status)}</dd>
        <dt>Established facts</dt>
        <dd className="multiline-value">
          {result.evidence.coverage.established.join("\n") || "None"}
        </dd>
        <dt>Unavailable facts</dt>
        <dd className="multiline-value">
          {result.evidence.coverage.unavailable.join("\n") || "None"}
        </dd>
        <dt>Not applicable</dt>
        <dd className="multiline-value">
          {result.evidence.coverage.notApplicable.join("\n") || "None"}
        </dd>
      </dl>
    </section>
    <section className="analysis-section">
      <h2>Limitations</h2>
      <ul>
        {limitations.map((limitation) => (
          <li key={limitation.id}>{limitation.message}</li>
        ))}
        {result.warnings.map((warning) => (
          <li key={`${warning.code}:${warning.observationIds.join(":")}`}>
            {warning.message}
          </li>
        ))}
        {result.data.deployment.source.exclusions.map((exclusion) => (
          <li key={`deployment:${exclusion}`}>
            Deployment source excludes {readable(exclusion)}.
          </li>
        ))}
        {result.data.coverage.source.exclusions.map((exclusion) => (
          <li key={`route:${exclusion}`}>
            Route-asset source excludes {readable(exclusion)}.
          </li>
        ))}
      </ul>
      <p>
        This result does not select a best route and does not establish minimum
        output, slippage, gas cost, transaction readiness, transfer success, or safety.
      </p>
    </section>
  </div>
);

export const UniswapV2QuoteView = ({
  request,
}: {
  readonly request?: BrowserFetch;
}) => {
  const [authority] = useState(createBrowserRequestAuthority);
  const [factory, setFactory] = useState("");
  const [tokenIn, setTokenIn] = useState("");
  const [tokenOut, setTokenOut] = useState("");
  const [amountIn, setAmountIn] = useState("");
  const [blockKind, setBlockKind] = useState<"latest" | "number">("latest");
  const [blockNumber, setBlockNumber] = useState("");
  const [state, setState] = useState<QuoteState>({ status: "idle" });

  useEffect(() => {
    authority.activate();
    return () => { authority.close(); };
  }, [authority]);

  const submit = async (): Promise<void> => {
    const active = authority.beginRead();
    if (active === undefined) return;
    setState({ status: "loading" });
    try {
      const result = await quoteUniswapV2ExactInput({
        tokenIn: { kind: "erc20", chainId: productChainId, address: tokenIn },
        tokenOut: { kind: "erc20", chainId: productChainId, address: tokenOut },
        factory,
        amountIn,
        block: blockKind === "latest"
          ? { kind: "latest" }
          : { kind: "number", blockNumber },
      }, {
        ...(request === undefined ? {} : { request }),
        signal: active.signal,
      });
      if (authority.isCurrent(active)) setState({ status: "available", result });
    } catch (error) {
      if (authority.isCurrent(active)) {
        setState({ status: "error", message: browserActionFailureMessage(error) });
      }
    }
  };

  const cancel = (): void => {
    authority.invalidateRead();
    setState({ status: "idle" });
  };

  return (
    <section className="uniswap-v2-quote" aria-labelledby="uniswap-v2-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Protocol read</p>
          <h1 id="uniswap-v2-heading">Uniswap V2 exact-input quote</h1>
        </div>
      </div>
      <p>
        Inspect every declared direct and one-intermediary candidate without
        choosing a preferred route.
      </p>
      <div className="inspection-form">
        <label>
          Factory
          <select value={factory} onChange={(event) => setFactory(event.target.value)}>
            <option value="">Select the registered factory</option>
            <option value={uniswapV2FactoryAddress}>{uniswapV2FactoryAddress}</option>
          </select>
        </label>
        <label>
          Raw input amount
          <input
            value={amountIn}
            onChange={(event) => setAmountIn(event.target.value)}
          />
        </label>
        <label>
          Input token address
          <input value={tokenIn} onChange={(event) => setTokenIn(event.target.value)} />
        </label>
        <label>
          Output token address
          <input value={tokenOut} onChange={(event) => setTokenOut(event.target.value)} />
        </label>
        <label>
          Block
          <select
            value={blockKind}
            onChange={(event) => setBlockKind(event.target.value === "number" ? "number" : "latest")}
          >
            <option value="latest">Latest canonical block</option>
            <option value="number">Exact block number</option>
          </select>
        </label>
        {blockKind === "number" ? (
          <label>
            Block number
            <input
              value={blockNumber}
              onChange={(event) => setBlockNumber(event.target.value)}
            />
          </label>
        ) : null}
      </div>
      <button
        type="button"
        disabled={state.status === "loading" || factory === ""}
        onClick={() => { void submit(); }}
      >
        {state.status === "loading" ? "Reading quote…" : "Read quote"}
      </button>
      {state.status === "loading" ? (
        <button type="button" onClick={cancel}>Cancel</button>
      ) : null}
      {state.status === "error" ? <p className="error">{state.message}</p> : null}
      {state.status === "available"
        ? <UniswapV2QuoteResult result={state.result} />
        : null}
    </section>
  );
};
