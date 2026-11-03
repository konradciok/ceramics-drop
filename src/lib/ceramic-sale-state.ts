import { cache } from 'react';
import { getSupabaseAdmin } from './supabase';
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

/** Request-scoped only: never cache mutable availability across requests. */
export const getCeramicSaleState = cache(async (): Promise<CeramicSaleState> => {
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
  return products.map((product) => {
    const piece = pieces.get(product.id);
    const activeDrop = !state.failed && drops.get(product.dropId)?.status === 'active';
    const reserved = piece?.status === 'reserved' &&
      (!piece.reserved_until || Date.parse(piece.reserved_until) > now || !Number.isFinite(Date.parse(piece.reserved_until)));
    const available = piece?.status === 'available' || (piece?.status === 'reserved' && !reserved);
    return {
      ...product,
      sold: piece ? piece.status === 'sold' : product.sold,
      showroom: piece?.showroom ?? product.showroom,
      onlineAvailable: activeDrop && available && !piece?.showroom && (product.status ?? 'active') === 'active',
      saleState: state.failed ? 'unknown' : product.sold || piece?.status === 'sold' ? 'sold' :
        !activeDrop || piece?.showroom ? 'archive' : reserved ? 'reserved' : available ? 'available' : 'unavailable',
    };
  });
}

export async function withCeramicSaleState(products: Product[]): Promise<Product[]> {
  if (!products.length) return products;
  return mergeCeramicSaleState(products, await getCeramicSaleState());
}
