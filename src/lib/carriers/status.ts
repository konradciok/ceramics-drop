/**
 * `orders.delivery_status` vocabulary. The app stores carrier status in the
 * InPost ShipX status names (the first carrier it integrated); every other
 * carrier adapter maps its own statuses onto these at ingest, so the account
 * page, the admin queue and the customer emails keep a single code path.
 */

/** Status at which the printable label becomes available (ShipX `confirmed`). */
export const LABEL_READY_STATUS = 'confirmed';
