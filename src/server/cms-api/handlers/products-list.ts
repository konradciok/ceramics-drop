import type { RouteDef } from '../router';
import { jsonResponse } from '../http';
import { loadProductResponses } from '../mapping';
import type { ProductResponse } from '../types';

const SORT_COLUMNS: Record<string, { column: string; ascending: boolean }> = {
  updated_desc: { column: 'updated_at', ascending: false },
  updated_asc: { column: 'updated_at', ascending: true },
  num_asc: { column: 'num', ascending: true },
  num_desc: { column: 'num', ascending: false },
};

export const productsListRoute: RouteDef = {
  method: 'GET',
  path: '/v1/products',
  handler: async (req, env, _params, ctx) => {
    const url = new URL(req.url);
    const type = url.searchParams.get('type');
    const status = url.searchParams.get('status');
    const rawQ = url.searchParams.get('q')?.trim();
    // Strip anything but safe id/num characters before it reaches a
    // PostgREST .or() filter string — untreated user input there is a
    // filter-injection vector (comma/paren/dot are filter metacharacters).
    const q = rawQ ? rawQ.replace(/[^a-zA-Z0-9_-]/g, '') : undefined;
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '20') || 20));
    const sort = SORT_COLUMNS[url.searchParams.get('sort') ?? 'updated_desc'] ?? SORT_COLUMNS.updated_desc;

    let query = ctx.supabase.from('products').select('id', { count: 'exact' });
    if (type === 'ceramic' || type === 'print') query = query.eq('type', type);
    if (status === 'draft' || status === 'active' || status === 'hidden' || status === 'archived') {
      query = query.eq('status', status);
    }
    if (q) query = query.or(`id.ilike.%${q}%,num.ilike.%${q}%`);

    query = query.order(sort.column, { ascending: sort.ascending }).range((page - 1) * pageSize, page * pageSize - 1);

    const { data, count, error } = await query;
    if (error) throw error;

    const ids = (data ?? []).map((row) => row.id as string);
    const responses = await loadProductResponses(ctx.supabase, env, ids);
    const items = ids.map((id) => responses.get(id)).filter((p): p is ProductResponse => Boolean(p));

    return jsonResponse({ items, total: count ?? 0, page, pageSize });
  },
};
