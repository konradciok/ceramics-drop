/**
 * TEMPORARY (2026-08): passe-partout (mount) disabled for all fine-art prints —
 * Prodigi's mount execution is unsatisfactory; may return with another supplier.
 * Gated at read time only: the two catalog roots (prints.ts export,
 * catalog/mappers.ts) + operator asset tooling. DB rows, SKU map, pricing,
 * token grammar, and order history are untouched.
 * REVERT: flip to false (or git-revert the commit, i18n copy included).
 */
export const MOUNT_TEMPORARILY_DISABLED = true;
