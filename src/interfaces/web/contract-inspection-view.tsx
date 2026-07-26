import {
  useEffect,
  useState,
} from "react";

import {
  contractInspectCapability,
  getCapabilityDefinitionSnapshot,
  productChainId,
  type CapabilitySuccess,
  type ContractAnalysis,
  type ContractInspectData,
  type Coverage,
  type EvidenceSource,
  type StaticScopeExclusion,
  type Warning,
} from "../../core/browser.js";
import {
  tokenInspectCapability,
  type TokenInspectionSuccess,
} from "../../token-catalog/browser.js";
import {
  browserActionFailureMessage,
  type BrowserFetch,
} from "./browser-client.js";
import { inspectContract } from "./contract-inspection-client.js";
import { createBrowserRequestAuthority } from "./request-authority.js";
import {
  inspectTokenContract,
} from "./token-catalog-client.js";
import { tokenInspectionFields } from "./token-catalog-view.js";

type InspectionKind = "contract" | "token";
type BlockKind = "latest" | "number";

type InspectionResult =
  | Readonly<{
      kind: "contract";
      result: CapabilitySuccess<ContractInspectData>;
    }>
  | Readonly<{
      kind: "token";
      result: TokenInspectionSuccess;
    }>;

type InspectionState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{ status: "available"; value: InspectionResult }>;

const contractLimitations =
  getCapabilityDefinitionSnapshot(contractInspectCapability).staticScopeExclusions;
const tokenLimitations =
  getCapabilityDefinitionSnapshot(tokenInspectCapability).staticScopeExclusions;

const readable = (value: string): string => value.replaceAll("_", " ");

const sourceReferenceText = (
  source: EvidenceSource,
): string => {
  switch (source.reference.kind) {
    case "public": return source.reference.uri;
    case "configured_rpc": return source.reference.publicOrigin;
    case "wallet_session": return source.reference.sourceId;
    case "wallet_sdk": return source.reference.sourceId;
    case "validated_input": return source.reference.sourceId;
  }
};

const proxyText = (analysis: ContractAnalysis): string => {
  if (analysis.proxy.status === "no_supported_proxy_observed") {
    return "No supported proxy form was observed. Unrecognized proxy forms remain possible.";
  }
  if (analysis.proxy.status === "unresolved") {
    return `Unresolved (${readable(analysis.proxy.reason)})`;
  }
  return `${readable(analysis.proxy.method)} to ${analysis.proxy.implementation}`;
};

const proxyAdminText = (analysis: ContractAnalysis): string => {
  if (analysis.proxy.status !== "resolved") return "Not applicable";
  if (analysis.proxy.admin.status === "observed") return analysis.proxy.admin.address;
  return readable(analysis.proxy.admin.status);
};

const controlText = (
  value:
    | ContractAnalysis["controls"]["owner"]
    | ContractAnalysis["controls"]["paused"]
    | ContractAnalysis["controls"]["defaultAdmins"],
): string => {
  if (value.status === "observed") {
    if ("members" in value) {
      return value.members.length === 0
        ? "No members observed"
        : value.members.join("\n");
    }
    return String(value.value);
  }
  if (value.status === "limit_exceeded") return `Limit exceeded (${value.count})`;
  if (value.status === "unavailable") return `Unavailable (${readable(value.reason)})`;
  return readable(value.status);
};

export const ContractAnalysisDetails = ({
  analysis,
  sources,
  coverage,
  warnings,
  limitations,
}: {
  readonly analysis: ContractAnalysis;
  readonly sources: readonly EvidenceSource[];
  readonly coverage: Coverage;
  readonly warnings: readonly Warning[];
  readonly limitations: readonly StaticScopeExclusion[];
}) => (
  <div className="contract-analysis">
    <div className="warning">
      <strong>Unresolved is not safe</strong>
      <p>Unavailable or unresolved information is not evidence that this contract is safe.</p>
    </div>
    <dl className="contract-analysis-fields">
      <dt>Target</dt><dd>{analysis.target}</dd>
      <dt>Canonical block</dt>
      <dd>{analysis.block.chainId} / {analysis.block.blockNumber} / {analysis.block.blockHash}</dd>
      <dt>Block timestamp</dt><dd>{analysis.block.blockTimestamp}</dd>
      <dt>Target code hash</dt><dd>{analysis.targetRuntimeCode.codeHash}</dd>
      <dt>Target code bytes</dt><dd>{analysis.targetRuntimeCode.byteLength}</dd>
      <dt>Proxy result</dt><dd>{proxyText(analysis)}</dd>
      {analysis.proxy.status === "resolved" ? (
        <>
          <dt>Implementation code hash</dt>
          <dd>{analysis.proxy.implementationRuntimeCode.codeHash}</dd>
          <dt>Implementation code bytes</dt>
          <dd>{analysis.proxy.implementationRuntimeCode.byteLength}</dd>
        </>
      ) : null}
      <dt>Proxy administrator</dt><dd>{proxyAdminText(analysis)}</dd>
      <dt>Owner</dt><dd>{controlText(analysis.controls.owner)}</dd>
      <dt>Paused</dt><dd>{controlText(analysis.controls.paused)}</dd>
      <dt>Default administrators</dt>
      <dd className="multiline-value">{controlText(analysis.controls.defaultAdmins)}</dd>
      <dt>Evidence coverage</dt><dd>{readable(coverage.status)}</dd>
    </dl>
    <section className="analysis-section">
      <h2>Source verification</h2>
      <ul className="analysis-list">
        {analysis.sources.map((source) => (
          <li key={`${source.role}:${source.address}`}>
            <strong>{readable(source.role)}</strong>
            <span>{source.address}</span>
            <span>{readable(source.status)}</span>
          </li>
        ))}
      </ul>
    </section>
    <section className="analysis-section">
      <h2>Declared functions</h2>
      {analysis.declaredFunctions.status === "observed" ? (
        <code className="declared-functions">
          {analysis.declaredFunctions.signatures.join("\n")}
        </code>
      ) : (
        <p>Unavailable ({readable(analysis.declaredFunctions.reason)})</p>
      )}
    </section>
    <section className="analysis-section">
      <h2>Evidence sources</h2>
      <ul className="analysis-list">
        {sources.map((source) => (
          <li key={source.observationId}>
            <strong>{readable(source.purpose)}</strong>
            <span>{source.owner}</span>
            <span className="scrolling-text">{sourceReferenceText(source)}</span>
          </li>
        ))}
      </ul>
    </section>
    <section className="analysis-section">
      <h2>Limitations</h2>
      <ul>
        {limitations.map((limitation) => (
          <li key={limitation.id}>{limitation.message}</li>
        ))}
        {warnings.map((warning) => (
          <li key={`${warning.code}:${warning.observationIds.join(":")}`}>{warning.message}</li>
        ))}
      </ul>
    </section>
  </div>
);

const InspectionResultView = ({ value }: { readonly value: InspectionResult }) => {
  if (value.kind === "contract") {
    return (
      <ContractAnalysisDetails
        analysis={value.result.data.analysis}
        sources={value.result.evidence.sources}
        coverage={value.result.evidence.coverage}
        warnings={value.result.warnings}
        limitations={contractLimitations}
      />
    );
  }
  return <TokenInspectionAnalysisDetails inspection={value.result} />;
};

export const TokenInspectionAnalysisDetails = ({
  inspection,
}: {
  readonly inspection: TokenInspectionSuccess;
}) => (
  <>
    <dl className="token-details">
      {tokenInspectionFields(inspection).flatMap((field) => [
        <dt key={`${field.label}:label`}>{field.label}</dt>,
        <dd key={`${field.label}:value`}>{field.value}</dd>,
      ])}
    </dl>
    <ContractAnalysisDetails
      analysis={inspection.data.analysis}
      sources={inspection.evidence.sources}
      coverage={inspection.evidence.coverage}
      warnings={inspection.warnings}
      limitations={tokenLimitations}
    />
  </>
);

export const ContractInspectionView = ({
  request,
}: {
  readonly request?: BrowserFetch;
}) => {
  const [authority] = useState(createBrowserRequestAuthority);
  const [kind, setKind] = useState<InspectionKind>("contract");
  const [address, setAddress] = useState("");
  const [blockKind, setBlockKind] = useState<BlockKind>("latest");
  const [blockNumber, setBlockNumber] = useState("");
  const [state, setState] = useState<InspectionState>({ status: "idle" });

  useEffect(() => {
    authority.activate();
    return () => { authority.close(); };
  }, [authority]);

  const inspect = async (): Promise<void> => {
    const active = authority.beginRead();
    if (active === undefined) return;
    setState({ status: "loading" });
    const block = blockKind === "latest"
      ? { kind: "latest" as const }
      : { kind: "number" as const, blockNumber };
    try {
      const result = kind === "contract"
        ? Object.freeze({
            kind,
            result: await inspectContract(
              { address, block },
              { ...(request === undefined ? {} : { request }), signal: active.signal },
            ),
          })
        : Object.freeze({
            kind,
            result: await inspectTokenContract(
              {
                asset: { kind: "erc20", chainId: productChainId, address },
                block,
              },
              { ...(request === undefined ? {} : { request }), signal: active.signal },
            ),
          });
      if (authority.isCurrent(active)) setState({ status: "available", value: result });
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
    <section className="contract-inspection" aria-labelledby="contract-inspection-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Robinhood Chain</p>
          <h1 id="contract-inspection-heading">Contract inspection</h1>
        </div>
      </div>
      <p>Inspect one contract or token at one canonical block.</p>
      <div className="inspection-form">
        <label className="field">
          <span>Inspection</span>
          <select
            value={kind}
            disabled={state.status === "loading"}
            onChange={(event) => { setKind(event.currentTarget.value as InspectionKind); }}
          >
            <option value="contract">Contract controls</option>
            <option value="token">Token contract</option>
          </select>
        </label>
        <label className="field">
          <span>Contract address</span>
          <input
            type="text"
            value={address}
            disabled={state.status === "loading"}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => { setAddress(event.currentTarget.value); }}
          />
        </label>
        <label className="field">
          <span>Block</span>
          <select
            value={blockKind}
            disabled={state.status === "loading"}
            onChange={(event) => { setBlockKind(event.currentTarget.value as BlockKind); }}
          >
            <option value="latest">Latest canonical block</option>
            <option value="number">Exact block number</option>
          </select>
        </label>
        {blockKind === "number" ? (
          <label className="field">
            <span>Block number</span>
            <input
              type="text"
              value={blockNumber}
              disabled={state.status === "loading"}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => { setBlockNumber(event.currentTarget.value); }}
            />
          </label>
        ) : null}
      </div>
      <div className="actions">
        {state.status === "loading" ? (
          <button type="button" className="secondary" onClick={cancel}>Cancel</button>
        ) : null}
        <button
          type="button"
          disabled={state.status === "loading"}
          onClick={() => { void inspect(); }}
        >
          {state.status === "loading" ? "Inspecting…" : "Inspect"}
        </button>
      </div>
      {state.status === "error" ? <div className="error" role="status">{state.message}</div> : null}
      {state.status === "available" ? <InspectionResultView value={state.value} /> : null}
    </section>
  );
};
