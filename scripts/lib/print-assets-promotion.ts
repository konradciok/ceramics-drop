/**
 * Dependency-injected adapter for the `promote_print_assets_ready` RPC — the
 * transactional staged → ready promotion used by `print-assets:verify`. Kept
 * out of the CLI entry point so tests can inject a fake client without importing
 * the side-effecting script. The RPC returns one row per requested key (the key
 * plus whether THIS call promoted it); the adapter re-checks that invariant and
 * reports how many rows it promoted.
 */

interface PromotionClient {
  rpc(
    name: 'promote_print_assets_ready',
    args: {
      p_product_id: string;
      p_revision: string;
      p_r2_keys: string[];
      p_verified_at: string;
    },
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

export async function promoteVerifiedAssets(input: {
  client: PromotionClient;
  productId: string;
  revision: string;
  r2Keys: string[];
  verifiedAt?: string;
}): Promise<{ promotedCount: number }> {
  const response = await input.client.rpc('promote_print_assets_ready', {
    p_product_id: input.productId,
    p_revision: input.revision,
    p_r2_keys: input.r2Keys,
    p_verified_at: input.verifiedAt ?? new Date().toISOString(),
  });
  if (response.error) {
    throw new Error(`Failed to promote verified assets transactionally: ${response.error.message}`);
  }
  if (!Array.isArray(response.data)) throw new Error('Promotion RPC returned a non-array response');
  const rows = response.data.map((value) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as { r2_key?: unknown }).r2_key !== 'string' ||
      typeof (value as { promoted?: unknown }).promoted !== 'boolean'
    ) {
      throw new Error('Promotion RPC returned a malformed row');
    }
    return value as { r2_key: string; promoted: boolean };
  });
  const returnedKeys = rows.map((row) => row.r2_key).sort();
  const expectedKeys = [...input.r2Keys].sort();
  if (JSON.stringify(returnedKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Promotion RPC returned ${returnedKeys.length}/${expectedKeys.length} requested key(s)`);
  }
  return { promotedCount: rows.filter((row) => row.promoted).length };
}
