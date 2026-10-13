import { create } from 'zustand';

interface Toast {
  id: number;
  message: string;
}

interface ToastState {
  items: Toast[];
  push: (message: string) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useToasts = create<ToastState>((set, get) => ({
  items: [],
  push: (message) => {
    const id = ++seq;
    set((s) => ({ items: [...s.items.slice(-2), { id, message }] }));
    setTimeout(() => get().dismiss(id), 3600);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

export const toast = (message: string) => useToasts.getState().push(message);

export function Toasts() {
  const items = useToasts((s) => s.items);
  if (items.length === 0) return null;
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast">
          {t.message}
        </div>
      ))}
    </div>
  );
}
