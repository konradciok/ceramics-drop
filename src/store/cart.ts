/* ============================================================
   Cart store (Zustand + localStorage)
   ------------------------------------------------------------
   Each piece is one-of-a-kind, so the cart is just a set of
   product IDs — no quantities. Persisted to localStorage under
   the same key the prototype used (`acc_cart_v1`).
   ============================================================ */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** True for a cart token of a product line this store no longer sells. */
export function isRetiredCartToken(id: unknown): boolean {
  return typeof id !== 'string' || id.startsWith('print:');
}

interface CartState {
  ids: string[];
  add: (id: string) => void;
  remove: (id: string) => void;
  /** Set the cart to exactly these ids (used to seed a private-sale link bundle). */
  replace: (ids: string[]) => void;
  clear: () => void;
}

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      ids: [],
      add: (id) =>
        set((s) => (s.ids.includes(id) ? s : { ids: [...s.ids, id] })),
      remove: (id) => set((s) => ({ ids: s.ids.filter((x) => x !== id) })),
      replace: (ids) => set({ ids: [...new Set(ids)] }),
      clear: () => set({ ids: [] }),
    }),
    {
      name: 'acc_cart_v1',
      // Fine-art prints moved to their own shop (2026-11) and can no longer be
      // bought here — drop any `print:` token a returning visitor's persisted
      // cart still holds, on every rehydrate, so it never reaches checkout.
      merge: (persisted, current) => {
        const ids = (persisted as Partial<CartState> | undefined)?.ids;
        return {
          ...current,
          ids: Array.isArray(ids) ? ids.filter((id) => !isRetiredCartToken(id)) : current.ids,
        };
      },
    },
  ),
);
