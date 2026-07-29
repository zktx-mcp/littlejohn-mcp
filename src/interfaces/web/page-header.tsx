import type { ReactNode } from "react";

export interface PageHeaderProps {
  readonly actions?: ReactNode;
  readonly breadcrumb?: ReactNode;
  readonly description?: string;
  readonly headingId?: string;
  readonly titleAction?: ReactNode;
  readonly title: string;
}

export const PageHeader = ({
  actions,
  breadcrumb,
  description,
  headingId,
  titleAction,
  title,
}: PageHeaderProps) => (
  <header className="page-header">
    {breadcrumb === undefined ? null : (
      <nav className="page-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>{breadcrumb}</li>
          <li aria-current="page">{title}</li>
        </ol>
      </nav>
    )}
    <div className="page-header-row">
      <div className="page-header-copy">
        <div className="page-header-title-row">
          <h1 id={headingId}>{title}</h1>
          {titleAction === undefined ? null : (
            <div className="page-header-title-action">{titleAction}</div>
          )}
        </div>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {actions === undefined ? null : (
        <div className="page-header-actions">{actions}</div>
      )}
    </div>
  </header>
);
