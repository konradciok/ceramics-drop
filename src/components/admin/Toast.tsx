'use client';

/* Lightweight toast stack for the admin surface. Mounted once in the admin
   layout; useAdminAction() pushes an entry on every action outcome so operators
   get consistent "saved / failed" feedback. Errors (and payment mutations that
   carry an id worth keeping) stick until dismissed; routine successes auto-hide. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface ToastItem {
  id: number;
  ok: boolean;
  text: string;
  sticky: boolean;
}

interface ToastApi {
  notify: (ok: boolean, text: string, opts?: { sticky?: boolean }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TTL_MS = 5000;

/** Provides the toast context and renders the toast stack. Mount once, high in
    the admin tree (the admin layout). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback<ToastApi['notify']>(
    (ok, text, opts) => {
      // Failures stay until dismissed (need attention); successes auto-hide unless
      // the caller asks to keep them (e.g. a refund id).
      const sticky = opts?.sticky ?? !ok;
      const id = (idRef.current += 1);
      setItems((prev) => [...prev, { id, ok, text, sticky }]);
      if (!sticky) timers.current.set(id, setTimeout(() => dismiss(id), TTL_MS));
    },
    [dismiss],
  );

  // Clear any pending timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) clearTimeout(handle);
      map.clear();
    };
  }, []);

  // Stable value so useToast() consumers (e.g. useAdminAction across the admin)
  // don't re-render every time a toast appears/disappears.
  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="adm-toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} role="status" className={`adm-toast ${t.ok ? 'ok' : 'err'}`}>
            <span>{t.text}</span>
            <button
              type="button"
              className="adm-toast-close"
              aria-label="Zamknij"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Access the toast API. Throws if used outside a {@link ToastProvider}. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
