import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  undoLabel?: string;
  onUndo?: () => Promise<void> | void;
  durationMs?: number;
}

interface AppState {
  toasts: ToastMessage[];
  pushToast: (toast: Omit<ToastMessage, 'id'>) => void;
  dismissToast: (id: string) => void;
  backupWarning: string | null;
  setBackupWarning: (msg: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  toasts: [],
  pushToast: (toast) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const ttl = toast.durationMs ?? (toast.onUndo ? 8000 : 5500);
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id }],
    }));
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    }, ttl);
  },
  dismissToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
  backupWarning: null,
  setBackupWarning: (msg) => set({ backupWarning: msg }),
}));
