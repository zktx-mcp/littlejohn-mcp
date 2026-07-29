import {
  getCapabilityDefinitionSnapshot,
  type ContractAnalysis,
  type Coverage,
  type StaticScopeExclusion,
  type Warning,
} from "../../core/browser.js";
import type {
  TokenInspectionSuccess,
} from "../../token-catalog/browser.js";
import { tokenInspectCapability } from "../../token-catalog/browser.js";
import { CopyableIdentifier } from "./copyable-identifier.js";
import {
  contractControlFailureReasonLabel,
  contractControlStatusLabel,
  contractProxyAdminStatusLabel,
  contractProxyMethodLabel,
  contractProxyStatusLabel,
  contractProxyUnresolvedReasonLabel,
  contractSourceRoleLabel,
  contractSourceVerificationLabel,
  evidenceCoverageLabel,
} from "./human-labels.js";
import { StatusIndicator, type StatusTone } from "./status-indicator.js";
import { tokenInspectionFields } from "./token-catalog-view.js";

const tokenLimitations =
  getCapabilityDefinitionSnapshot(tokenInspectCapability).staticScopeExclusions;

const proxyText = (analysis: ContractAnalysis): string => {
  if (analysis.proxy.status === "no_supported_proxy_observed") {
    return "No supported proxy form was observed. Unrecognized proxy forms remain possible.";
  }
  if (analysis.proxy.status === "unresolved") {
    return `Unresolved (${contractProxyUnresolvedReasonLabel(analysis.proxy.reason)})`;
  }
  return `${contractProxyMethodLabel(analysis.proxy.method)} to ${analysis.proxy.implementation}`;
};

const proxyAdminText = (analysis: ContractAnalysis): string => {
  if (analysis.proxy.status !== "resolved") return "Not applicable";
  if (analysis.proxy.admin.status === "observed") {
    return analysis.proxy.admin.address;
  }
  return contractProxyAdminStatusLabel(analysis.proxy.admin.status);
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
  if (value.status === "limit_exceeded") {
    return `Result limit exceeded (${value.count})`;
  }
  if (value.status === "unavailable") {
    return `Unavailable (${contractControlFailureReasonLabel(value.reason)})`;
  }
  return contractControlStatusLabel(value.status);
};

const coverageTone = (coverage: Coverage): StatusTone =>
  coverage.status === "complete"
    ? "current"
    : coverage.status === "partial"
      ? "partial"
      : "unavailable";

export const ContractControlSummary = ({
  analysis,
  coverage,
}: {
  readonly analysis: ContractAnalysis;
  readonly coverage: Coverage;
}) => (
  <section
    className="analysis-control-summary"
    aria-labelledby="analysis-control-summary-heading"
  >
    <h2 id="analysis-control-summary-heading">Control summary</h2>
    <div className="analysis-status-row">
      <StatusIndicator
        tone={analysis.proxy.status === "resolved"
          ? "current"
          : analysis.proxy.status === "unresolved"
            ? "warning"
            : "unavailable"}
        label={contractProxyStatusLabel(analysis.proxy.status)}
      />
      <StatusIndicator
        tone={coverageTone(coverage)}
        label={`${evidenceCoverageLabel(coverage.status)} coverage`}
      />
    </div>
    <dl className="analysis-control-grid">
      <dt>Proxy</dt>
      <dd>
        {analysis.proxy.status === "resolved" ? (
          <>
            {contractProxyMethodLabel(analysis.proxy.method)} to{" "}
            <CopyableIdentifier
              label="proxy implementation address"
              value={analysis.proxy.implementation}
            />
          </>
        ) : proxyText(analysis)}
      </dd>
      <dt>Source verification</dt>
      <dd>
        <ul className="analysis-inline-list">
          {analysis.sources.map((source) => (
            <li key={`${source.role}:${source.address}`}>
              {contractSourceRoleLabel(source.role)}:{" "}
              {contractSourceVerificationLabel(source.status)}
            </li>
          ))}
        </ul>
      </dd>
      <dt>Owner</dt><dd>{controlText(analysis.controls.owner)}</dd>
      <dt>Paused</dt><dd>{controlText(analysis.controls.paused)}</dd>
      <dt>Proxy administrator</dt>
      <dd>
        {analysis.proxy.status === "resolved" &&
        analysis.proxy.admin.status === "observed"
          ? <CopyableIdentifier
              label="proxy administrator address"
              value={analysis.proxy.admin.address}
            />
          : proxyAdminText(analysis)}
      </dd>
      <dt>Default administrators</dt>
      <dd className="multiline-value">
        {controlText(analysis.controls.defaultAdmins)}
      </dd>
    </dl>
  </section>
);

export const ContractAnalysisDetails = ({
  analysis,
  coverage,
  warnings,
  limitations,
}: {
  readonly analysis: ContractAnalysis;
  readonly coverage: Coverage;
  readonly warnings: readonly Warning[];
  readonly limitations: readonly StaticScopeExclusion[];
}) => (
  <div className="contract-analysis-details">
    <section
      className="analysis-conclusion"
      aria-labelledby="analysis-conclusion-heading"
    >
      <h2 id="analysis-conclusion-heading">Scam status</h2>
      <p className="analysis-conclusion-value">Not established</p>
      <p>
        Contract controls and source observations do not establish that this
        contract is safe or malicious.
      </p>
    </section>
    <ContractControlSummary analysis={analysis} coverage={coverage} />
    <section
      className="analysis-limitations"
      aria-labelledby="analysis-limitations-heading"
    >
      <h2 id="analysis-limitations-heading">What this analysis cannot establish</h2>
      <ul>
        {limitations.map((limitation) => (
          <li key={limitation.id}>{limitation.message}</li>
        ))}
        {warnings.map((warning) => (
          <li key={`${warning.code}:${warning.observationIds.join(":")}`}>
            {warning.message}
          </li>
        ))}
      </ul>
    </section>
  </div>
);

export const TokenInspectionAnalysisDetails = ({
  inspection,
}: {
  readonly inspection: TokenInspectionSuccess;
}) => (
  <>
    <ContractAnalysisDetails
      analysis={inspection.data.analysis}
      coverage={inspection.evidence.coverage}
      warnings={inspection.warnings}
      limitations={tokenLimitations}
    />
    <section
      className="token-analysis-summary"
      aria-labelledby="token-analysis-summary-heading"
    >
      <h2 id="token-analysis-summary-heading">Token facts</h2>
      <dl className="analysis-control-grid">
        {tokenInspectionFields(inspection).flatMap((field) => [
          <dt key={`${field.label}:label`}>{field.label}</dt>,
          <dd key={`${field.label}:value`}>{field.value}</dd>,
        ])}
      </dl>
    </section>
  </>
);
