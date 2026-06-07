/** Single source of truth — all @ciok.art addresses */
export const EMAIL = {
  contact: 'hej@ciok.art',
  shopFrom: 'sklep@ciok.art',
  labelsFrom: 'etykiety@ciok.art',
  shopFromDisplay: 'Anna Ciok Studio',
  labelsFromDisplay: 'Etykiety InPost',
} as const;

export const EMAIL_FROM = {
  shop: `${EMAIL.shopFromDisplay} <${EMAIL.shopFrom}>`,
  labels: `${EMAIL.labelsFromDisplay} <${EMAIL.labelsFrom}>`,
} as const;
