'use client';

/* Lightweight toast stack for the admin surface. Mounted once in the admin
   layout; useAdminAction() pushes an entry on every action outcome so operators
   get consistent "saved / failed" feedback instead of per-component inline text. */
import { createContext, useCallback, useContext, useRef, useState } from 'react';

interface ToastItem {
  id: number;
  ok: boolean;
  text: string;
}

interface ToastApi {
  notify: (ok: boolean, text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TTL_MS = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const notify = useCallback((ok: boolean, text: string) => {
    const id = (idRef.current += 1);
    setItems((prev) => [...prev, { id, ok, text }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), TTL_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="adm-toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} role="status" className={`adm-toast ${t.ok ? 'ok' : 'err'}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
