export type ToastTone = "success" | "warn" | "danger" | "info";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  /** Optional detail lines (e.g. 422 field errors). */
  detail?: string;
}

export interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

/** Bottom-right stack. Auto-dismiss timing lives in `useToasts` (App.tsx). */
export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <div className="toast__body">
            <div className="toast__message">{toast.message}</div>
            {toast.detail ? <div className="toast__detail">{toast.detail}</div> : null}
          </div>
          <button
            type="button"
            className="toast__close"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export default ToastStack;
