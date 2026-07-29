export const LoadingIndicator = ({
  label,
  announce = true,
}: {
  readonly label: string;
  readonly announce?: boolean;
}) => (
  <div className="loading-indicator" role={announce ? "status" : undefined}>
    <span className="loading-indicator-mark" aria-hidden="true" />
    <span>{label}</span>
  </div>
);
