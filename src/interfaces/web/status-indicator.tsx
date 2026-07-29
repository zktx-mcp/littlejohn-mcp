export type StatusTone =
  | "current"
  | "stale"
  | "partial"
  | "unavailable"
  | "warning"
  | "error";

export interface StatusIndicatorProps {
  readonly label: string;
  readonly tone: StatusTone;
}

export const StatusIndicator = ({ label, tone }: StatusIndicatorProps) => (
  <span className={`status-indicator status-${tone}`}>
    <span className="status-marker" aria-hidden="true" />
    <span>{label}</span>
  </span>
);
