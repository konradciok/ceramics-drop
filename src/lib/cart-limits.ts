/**
 * Most one-of-a-kind ceramic pieces a single order may hold.
 *
 * Every piece in a checkout is reserved for 15 minutes before payment, so
 * without a cap one anonymous POST could hold the whole shop (audit CO-01),
 * and a long id list fans out into per-id catalogue reads (CO-02). Enforced
 * by validateCart (checkout + promo preview) before any I/O. A business
 * limit: raise it here if a real buyer ever needs a bigger order.
 *
 * Its own dependency-free module so the client cart and operator scripts can
 * read it without pulling in the product registry.
 */
export const MAX_CERAMIC_PIECES_PER_ORDER = 12;
