import React from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

export const ToastContainer: React.FC = () => {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="no-print fixed right-5 bottom-6 z-[120] flex w-96 max-w-[calc(100vw-2.5rem)] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-start gap-3 rounded-lg border bg-white p-3.5 shadow-xl ${
            toast.type === 'error'
              ? 'border-red-300'
              : toast.type === 'warning'
              ? 'border-amber-300'
              : toast.type === 'success'
              ? 'border-emerald-300'
              : 'border-slate-200'
          }`}
        >
          {toast.type === 'error' ? (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          ) : toast.type === 'warning' ? (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-900">{toast.title}</div>
            {toast.message && (
              <div className="mt-0.5 break-words text-xs text-slate-700">{toast.message}</div>
            )}
            {toast.onUndo && (
              <button
                type="button"
                onClick={async () => {
                  const fn = toast.onUndo;
                  dismissToast(toast.id);
                  if (fn) await fn();
                }}
                className="mt-1.5 inline-flex items-center rounded border border-slate-300 bg-slate-50 px-2.5 py-0.5 text-xs font-semibold text-[#1D4ED8] hover:bg-blue-50"
              >
                {toast.undoLabel || 'Annuler'}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Fermer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};
