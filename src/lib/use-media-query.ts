'use client';

import { useSyncExternalStore } from 'react';

type Store = {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => boolean;
};

// One store per query string so subscribe/getSnapshot keep a stable identity
// across renders (useSyncExternalStore resubscribes when they change).
const stores = new Map<string, Store>();

function storeFor(query: string): Store {
  let store = stores.get(query);
  if (!store) {
    store = {
      subscribe: (onChange) => {
        const mql = window.matchMedia(query);
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
      },
      getSnapshot: () => window.matchMedia(query).matches,
    };
    stores.set(query, store);
  }
  return store;
}

const getServerSnapshot = () => false;

/**
 * Reactive matchMedia — same useSyncExternalStore approach as useMounted, so
 * there is no setState-in-effect. The server snapshot is always false: SSR and
 * the hydration render emit the non-matching variant, and the real value
 * applies immediately after hydration, so callers must make sure both variants
 * look identical wherever the query would match (CSS media queries, not JS,
 * decide the visual state).
 */
export function useMediaQuery(query: string): boolean {
  const store = storeFor(query);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
}
