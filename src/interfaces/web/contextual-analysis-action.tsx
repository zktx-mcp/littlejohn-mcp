import type { MouseEvent } from "react";

import type { AnalysisTarget } from "./analysis-dialog.js";

export interface ContextualAnalysisActionProps {
  readonly disabled?: boolean;
  readonly label: string;
  readonly target: AnalysisTarget;
  readonly onAnalyze: (
    target: AnalysisTarget,
    trigger: HTMLButtonElement,
  ) => void;
}

export const ContextualAnalysisAction = ({
  disabled = false,
  label,
  target,
  onAnalyze,
}: ContextualAnalysisActionProps) => (
  <button
    type="button"
    className="contextual-analysis-action secondary"
    disabled={disabled}
    onClick={(event: MouseEvent<HTMLButtonElement>) => {
      onAnalyze(target, event.currentTarget);
    }}
  >
    {label}
  </button>
);
