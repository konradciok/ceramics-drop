import type { CategorySlug, PrintSize, PrintFrameColour } from '@/lib/types';

export type LocalizedText = { pl: string; en?: string; es?: string; de?: string };
export type LocalizedTextOptional = { pl?: string; en?: string; es?: string; de?: string };

export type CeramicDraft = {
  type: 'ceramic';
  category: Exclude<CategorySlug, 'fine-art-prints'>;
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

// --- Generic Field[]/Resource shape (collections, content, pricing,
// shipping-rates — this task only implements collections; the contract's
// `Field`/`Resource` schemas are shared verbatim across all four kinds). See
// contracts/cms-v1.json's Field/Resource schemas — greenfield, not derived
// from ProductDraft/ProductResponse above (those are ceramics-specific).
export type FieldType = 'text' | 'richtext' | 'number' | 'productIds';
export type FieldLocale = 'pl' | 'en' | 'es' | 'de' | 'none';

export type Field = {
  key: string;
  label: string;
  type: FieldType;
  value: string;
  locale: FieldLocale;
  sourceLocale: FieldLocale;
};

export type ResourceKind = 'collections' | 'content' | 'pricing' | 'shipping-rates';

export type CollectionResponse = {
  id: string;
  kind: 'collections';
  name: string;
  revision: number;
  publishedRevision: number | null;
  fields: Field[];
};

// --- Asset (contracts/cms-v1.json's Asset schema) — shared by
// uploads-mapping.ts's mapConfirmedUploadToAsset (POST /v1/uploads/{id}/confirm's
// response) and assets-mapping.ts's mapping of print_fulfilment_assets rows
// (GET /v1/assets) — same wire type, two different source tables (Task 9).
export type AssetStatus = 'uploaded' | 'processing' | 'ready' | 'failed';

export type AssetResponse = {
  id: string;
  name: string;
  revision: number;
  status: AssetStatus;
  ratio: string;
  url: string;
  usages: string[];
  error: string;
};
