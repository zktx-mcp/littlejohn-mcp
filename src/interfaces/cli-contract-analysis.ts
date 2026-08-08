import type { ContractAnalysis } from "../core/index.js";

export const contractAnalysisHumanLines = (
  analysis: ContractAnalysis,
): readonly string[] => Object.freeze([
  `Runtime code bytes: ${analysis.targetRuntimeCode.byteLength}`,
  `Runtime code hash: ${analysis.targetRuntimeCode.codeHash}`,
  `Proxy: ${analysis.proxy.status}`,
  ...(analysis.proxy.status === "resolved"
    ? [
        `Proxy method: ${analysis.proxy.method}`,
        `Implementation: ${analysis.proxy.implementation}`,
      ]
    : analysis.proxy.status === "unresolved"
      ? [
          `Proxy reason: ${analysis.proxy.reason}`,
          ...(analysis.proxy.reason === "implementation_terminality_unresolved"
            ? [
                `Observed first-hop proxy method: ${analysis.proxy.firstHop.method}`,
                `Observed first-hop implementation: ${analysis.proxy.firstHop.implementation}`,
                "Observed first-hop implementation admitted as effective: no",
                `Observed first-hop proxy administrator: ${
                  analysis.proxy.firstHop.admin.status === "observed"
                    ? analysis.proxy.firstHop.admin.address
                    : analysis.proxy.firstHop.admin.status}`,
                `Candidate terminality: ${analysis.proxy.terminality.status}${
                  analysis.proxy.terminality.status === "supported_proxy_marker_observed"
                    ? ` (${analysis.proxy.terminality.method})`
                    : ""}`,
              ]
            : []),
        ]
      : []),
  ...analysis.sources.map((source) =>
    `Source ${source.role}: ${source.status} (${source.address})`),
  `Declared functions: ${analysis.declaredFunctions.status === "observed"
    ? analysis.declaredFunctions.signatures.length
    : `unavailable (${analysis.declaredFunctions.reason})`}`,
  `Owner: ${analysis.controls.owner.status}`,
  `Paused: ${analysis.controls.paused.status}`,
  `Default administrators: ${analysis.controls.defaultAdmins.status}`,
]);
