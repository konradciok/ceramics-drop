/**
 * Enqueue a Prodigi fulfilment job for a paid print order.
 * Real implementation in Task 13 — stub returns void for now.
 */
export async function enqueueProdigi(
  orderId: string,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<void> {
  // ponytail: stub — wired but inert until Task 13
  void env;
  void ctx;
  console.log('[enqueueProdigi] stub — orderId:', orderId);
}
