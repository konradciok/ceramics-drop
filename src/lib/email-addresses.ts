/** Single source of truth — all @ciok.art addresses */
export const EMAIL = {
  contact: 'hej@ciok.art',
  /** Resend FROM for all transactional mail (no OVH mailbox required). */
  shopFrom: 'sklep@ciok.art',
  shopFromDisplay: 'Anna Ciok Studio',
} as const;

export const EMAIL_FROM = `${EMAIL.shopFromDisplay} <${EMAIL.shopFrom}>`;
