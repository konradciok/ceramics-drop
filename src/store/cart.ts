/* ============================================================
   Cart store (Zustand + localStorage)
   ------------------------------------------------------------
   Each piece is one-of-a-kind, so the cart is just a set of
   product IDs — no quantities. Persisted to localStorage under
   the same key the prototype used (`acc_cart_v1`).
   ============================================================ */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface CartState {
  ids: string[];
  has: (id: string) => boolean;
  /** Add the piece if absent, remove it if present. */
  toggle: (id: string) => void;
  add: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      ids: [],
      has: (id) => get().ids.includes(id),
      toggle: (id) =>
        set((s) => ({
          ids: s.ids.includes(id)
            ? s.ids.filter((x) => x !== id)
            : [...s.ids, id],
        })),
      add: (id) =>
        set((s) => (s.ids.includes(id) ? s : { ids: [...s.ids, id] })),
      remove: (id) => set((s) => ({ ids: s.ids.filter((x) => x !== id) })),
      clear: () => set({ ids: [] }),
    }),
    { name: 'acc_cart_v1' },
  ),
);
