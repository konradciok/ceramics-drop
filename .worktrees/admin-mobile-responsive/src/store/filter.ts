/* ============================================================
   Shop status filter store (Zustand + localStorage)
   ------------------------------------------------------------
   Holds the active shop view (all | available | sold). Persisted
   under `acc_filter_v1` so the choice follows the visitor across
   the /sklep hub and the per-category collection pages and
   survives reload. Shared, client-only state — the actual
   filtering lives in src/lib/status-filter.ts.
   ============================================================ */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { StatusFilter } from '@/lib/status-filter';

interface FilterState {
  status: StatusFilter;
  setStatus: (status: StatusFilter) => void;
}

export const useFilter = create<FilterState>()(
  persist(
    (set) => ({
      status: 'all',
      setStatus: (status) => set({ status }),
    }),
    { name: 'acc_filter_v1' },
  ),
);
