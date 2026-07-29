import {
  useEffect,
  useRef,
  type ReactNode,
} from "react";

import { Icon } from "./icons.js";

export interface DialogShellProps {
  readonly titleId: string;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly dismissible: boolean;
  readonly onClose: () => void;
}

export const DialogShell = ({
  titleId,
  title,
  description,
  children,
  footer,
  className,
  dismissible,
  onClose,
}: DialogShellProps) => {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    element.showModal();
    element.focus();
    return () => {
      if (element.open) element.close();
    };
  }, []);

  const close = (): void => {
    if (dismissible) onClose();
  };

  return (
    <dialog
      ref={dialog}
      className={`application-dialog dialog-shell${className === undefined ? "" : ` ${className}`}`}
      aria-labelledby={titleId}
      aria-modal="true"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) close();
      }}
    >
      <div className="dialog-shell-frame">
        <header className="dialog-shell-header">
          <div>
            <h1 id={titleId}>{title}</h1>
            {description === undefined ? null : <p>{description}</p>}
          </div>
          {dismissible ? (
            <button
              type="button"
              className="icon-button unfilled dialog-shell-close"
              aria-label={`Close ${title}`}
              title={`Close ${title}`}
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          ) : null}
        </header>
        <div className="dialog-shell-body">{children}</div>
        {footer === undefined ? null : (
          <footer className="dialog-shell-footer">{footer}</footer>
        )}
      </div>
    </dialog>
  );
};
