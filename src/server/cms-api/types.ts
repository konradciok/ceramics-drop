import type { CategorySlug, PrintSize, PrintFrameColour } from '@/lib/types';

export type LocalizedText = { pl: string; en?: string; es?: string; de?: string };
export type LocalizedTextOptional = { pl?: string; en?: string; es?: string; de?: string };

export type CeramicDraft = {
  type: 'ceramic';
  category: CategorySlug;
  displayNumber: string;
  measure: string;
  pricePln: number;
  priceEur: number;
  priceGbp: number;
  images: string[];
  title: LocalizedText;
  description: LocalizedText;
  seo?: LocalizedTextOptional;
  showroom: boolean;
  dropId?: string;
};

export type PrintDraft = {
  type: 'print';
  displayNumber: string;
  sizes: PrintSize[];
  frameColours?: PrintFrameColour[];
  mountAvailable: boolean;
  unavailable?: string[];
  images: string[];
  title: LocalizedText;
  description: LocalizedText;
  seo?: LocalizedTextOptional;
};

export type ProductDraft = CeramicDraft | PrintDraft;

export type ProofStatus = 'staged' | 'ready' | 'retired' | 'revoked';

export type Proof = {
  id: string;
  variantKey: string;
  revision: string;
  status: ProofStatus;
  url: string | null;
};

export type ProductStatus = 'draft' | 'active' | 'hidden' | 'archived';
export type ProductAvailability = 'available' | 'reserved' | 'sold' | 'showroom';

export type ProductResponse = {
  id: string;
  type: 'ceramic' | 'print';
  revision: number;
  publishedRevision: number | null;
  status: ProductStatus;
  draft: ProductDraft;
  thumbnail: string;
  proofs: Proof[];
  availability: ProductAvailability;
};
