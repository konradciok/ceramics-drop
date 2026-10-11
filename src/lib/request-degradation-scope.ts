// Worker-only half of request-degradation.ts: owns the AsyncLocalStorage
// (a `node:` import, so it must stay out of anything a client component can
// reach). Imported by worker.ts only.
import { AsyncLocalStorage } from 'node:async_hooks';
import { REQUEST_DEGRADATION_KEY, type RequestDegradation } from './request-degradation';

function degradationStorage(): AsyncLocalStorage<RequestDegradation> {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[REQUEST_DEGRADATION_KEY] as AsyncLocalStorage<RequestDegradation> | undefined;
  if (existing) return existing;
  const created = new AsyncLocalStorage<RequestDegradation>();
  g[REQUEST_DEGRADATION_KEY] = created;
  return created;
}

/** Run `fn` inside a fresh per-request degradation scope and hand it the scope's state. */
export function runWithRequestDegradation<T>(fn: (state: RequestDegradation) => Promise<T>): Promise<T> {
  const state: RequestDegradation = { ceramicCatalogColdFailClosed: false };
  return degradationStorage().run(state, () => fn(state));
}
