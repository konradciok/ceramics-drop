import { cache } from 'react';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getSupabaseAdmin } from './supabase';
import { FALLBACK_CURRENT_DROP_ID, registryProducts } from './products';
import { dropTier } from './drop-visibility';
import { markCeramicCatalogColdFailClosed } from './request-degradation';
import { supabaseTimeout } from './supabase-timeout';
import type { Product } from './types';

export type CeramicPieceState = {
  product_id: string;
  status: string;
  showroom: boolean;
  reserved_until: string | null;
};
export type CeramicDropState = { id: string; label: string; status: string };
export type CeramicSaleState = {
  pieces: CeramicPieceState[];
  drops: CeramicDropState[];
  failed: boolean;
};

/**
 * Hermetic-e2e switch. The @ci Playwright suite runs `next start` with no
 * backend, where real sale state fails closed and no ceramic is purchasable —
 * so it could never exercise the ceramic add-to-cart funnel. With
 * `E2E_CERAMIC_SALE_FIXTURE=1` AND no Supabase configured anywhere, every
 * registry piece reads as available in an active drop. The second condition is
 * the safety rail: a deployed Worker always has `SUPABASE_URL`, so the fixture
 * can never turn on in production even if the variable leaked there.
 */
export function ceramicSaleFixtureEnabled(): boolean {
  if (process.env.E2E_CERAMIC_SALE_FIXTURE !== '1') return false;
  if (process.env.SUPABASE_URL) return false;
  try {
    if (getCloudflareContext().env.SUPABASE_URL) return false;
  } catch {
    // No Workers request context (plain `next start`): nothing more to check.
  }
  return true;
}

function ceramicSaleFixture(): CeramicSaleState {
  const products = registryProducts();
  return {
    pieces: products.map((p) => ({ product_id: p.id, status: 'available', showroom: false, reserved_until: null })),
    drops: [...new Set(products.map((p) => p.dropId))].map((id) => ({ id, label: id, status: 'active' })),
    failed: false,
  };
}

/** Request-scoped only: never cache mutable availability across requests. */
export const getCeramicSaleState = cache(async (): Promise<CeramicSaleState> => {
  if (ceramicSaleFixtureEnabled()) return ceramicSaleFixture();
  try {
    const db = getSupabaseAdmin();
    const [pieces, drops] = await Promise.all([
      db.from('piece_state').select('product_id,status,showroom,reserved_until').abortSignal(supabaseTimeout()),
      db.from('drops').select('id,label,status').abortSignal(supabaseTimeout()),
    ]);
    if (pieces.error) throw pieces.error;
    if (drops.error) throw drops.error;
    return { pieces: pieces.data ?? [], drops: drops.data ?? [], failed: false };
  } catch (error) {
    console.error('[ceramic-availability] Sale disabled because availability could not be verified', error);
    return { pieces: [], drops: [], failed: true };
  }
});

export function mergeCeramicSaleState(products: Product[], state: CeramicSaleState, now = Date.now()): Product[] {
  const pieces = new Map(state.pieces.map((p) => [p.product_id, p]));
  const drops = new Map(state.drops.map((d) => [d.id, d]));
  let degraded = false;
  const merged = products.map((product): Product => {
    const piece = pieces.get(product.id);
    const tier = dropTier(product.dropId, state.drops, state.failed, FALLBACK_CURRENT_DROP_ID);
    if (state.failed && tier === 'hidden') degraded = true;
    const activeDrop = !state.failed && drops.get(product.dropId)?.status === 'active';
    const reserved = piece?.status === 'reserved' &&
      (!piece.reserved_until || Date.parse(piece.reserved_until) > now || !Number.isFinite(Date.parse(piece.reserved_until)));
    const available = piece?.status === 'available' || (piece?.status === 'reserved' && !reserved);
    return {
      ...product,
      dropTier: tier,
      sold: piece ? piece.status === 'sold' : product.sold,
      showroom: piece?.showroom ?? product.showroom,
      onlineAvailable: activeDrop && available && !piece?.showroom && (product.status ?? 'active') === 'active',
      saleState: state.failed ? 'unknown' : product.sold || piece?.status === 'sold' ? 'sold' :
        !activeDrop || piece?.showroom ? 'archive' : reserved ? 'reserved' : available ? 'available' : 'unavailable',
    };
  });
  // Drops could not be read: pieces outside the fallback drop are withheld,
  // so answer crawlers 503 instead of letting those PDPs read as gone.
  if (degraded) markCeramicCatalogColdFailClosed();
  return merged;
}

export async function withCeramicSaleState(products: Product[]): Promise<Product[]> {
  if (!products.length) return products;
  return mergeCeramicSaleState(products, await getCeramicSaleState());
}
