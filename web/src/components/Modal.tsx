import { useEffect, useRef, type ReactNode } from "react";

export interface ModalProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** `panel` slides in from the right (job editor); `dialog` is centred. */
  variant?: "panel" | "dialog";
  /** Extra class for width tuning (e.g. run detail uses a wide panel). */
  className?: string;
}

/**
 * Overlay container used by the job editor and the run detail view.
 *
 * Escape is handled at the document level (a React `onKeyDown` on the panel only
 * fires while focus is already inside it) and focus moves into the panel on
 * open, so keyboard users are never stranded on the page behind the overlay.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  variant = "panel",
  className = "",
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    // Move focus to the first meaningful control, falling back to the panel.
    const target = panel.querySelector<HTMLElement>(
      "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])",
    );
    (target ?? panel).focus();
  }, []);

  return (
    <div
      className={`overlay overlay--${variant}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`modal modal--${variant} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="modal__head">
          <div className="modal__titles">
            <h2 className="modal__title">{title}</h2>
            {subtitle ? <p className="modal__subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export default Modal;
