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

// --- Generic Field[]/Resource shape, shared verbatim by all four resource
// kinds. All four are implemented: collections, content, pricing and
// shipping-rates each have their own *-mapping.ts / *-validation.ts pair and
// handler set, and all of them round-trip through these types. See
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

// --- Job (contracts/cms-v1.json's Job schema) — Priority 8 / Phase 2 (Task
// 10). See src/server/cms-api/jobs-mapping.ts for the print_asset_jobs row ->
// wire mapping and src/server/asset-jobs/{enqueue,process-job}.ts for the
// underlying durable job queue.
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type JobResponse = {
  id: string;
  assetId: string;
  revision: number;
  status: JobStatus;
  progress: number;
  error: string;
};
