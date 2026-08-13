// Prodigi API v4.0 types — plain TypeScript, no Zod.

export interface ProdigiOrderItem {
  sku: string;
  copies: number;
  sizing: 'fillPrintArea' | 'fitPrintArea' | 'stretchToPrintArea';
  attributes?: Record<string, string>;
  assets: Array<{
    printArea: string;
    url: string;
    md5Hash?: string;
    pageCount?: number;
  }>;
  /**
   * What WE charged the customer for this item (sent in the ORDER currency for
   * customs/records). L-22/F-4 (rehearsal): money fields Prodigi RETURNS on
   * order reads are quoted in the merchant-account currency (EUR for this
   * account), NOT the order currency — never reconcile them 1:1 against what
   * was sent here.
   */
  recipientCost?: { amount: string; currency: string };
}

export interface ProdigiRecipient {
  name: string;
  email?: string;
  phoneNumber?: string;
  address: {
    line1: string;
    line2?: string;
    postalOrZipCode: string;
    countryCode: string;
    townOrCity: string;
    stateOrCounty?: string;
  };
}

export interface ProdigiOrderRequest {
  shippingMethod: string;
  idempotencyKey: string;
  callbackUrl?: string;
  merchantReference?: string;
  recipient: ProdigiRecipient;
  items: ProdigiOrderItem[];
  metadata?: Record<string, unknown>;
}

export interface ProdigiShipment {
  id?: string;
  status?: string;
  carrier?: { name?: string; service?: string };
  tracking?: { number?: string; url?: string };
  dispatchDate?: string;
}

/** Per-order issue as documented for `status.issues` (v4). */
export interface ProdigiOrderIssue {
  objectId?: string;
  errorCode?: string;
  description?: string;
  authorisationDetails?: unknown;
  [key: string]: unknown;
}

export interface ProdigiOrderResponse {
  /**
   * Docs list `created` / `createdWithIssues` / `alreadyExists` / `onHold`, but
   * examples elsewhere use PascalCase — compare case-insensitively (same
   * self-disagreement as ProdigiCancelResponse below).
   */
  outcome: 'Created' | 'CreatedWithIssues' | 'AlreadyExists' | 'OnHold' | string;
  order: {
    id: string;
    merchantReference?: string;
    status: { stage: string; issues?: ProdigiOrderIssue[] };
    items: Array<{ id: string; sku: string; status: { detail: string } }>;
    shipments?: ProdigiShipment[];
    recipient?: ProdigiRecipient;
    shippingMethod?: string;
    metadata?: Record<string, unknown>;
  };
  traceParent?: string;
}

/** Filters accepted by GET /orders. Array filters are encoded as repeated query keys. */
export interface ProdigiOrderListParams {
  top?: number;
  skip?: number;
  createdFrom?: string;
  createdTo?: string;
  status?: string;
  orderIds?: string[];
  merchantReferences?: string[];
}

export interface ProdigiOrderListResponse {
  outcome: string;
  orders: ProdigiOrderResponse['order'][];
  traceParent?: string;
  /** Prodigi may add paging information without changing the orders contract. */
  [key: string]: unknown;
}

/** POST /quotes accepts the complete API body, including each item's print areas. */
export interface ProdigiQuoteRequest {
  shippingMethod?: string;
  currencyCode?: string;
  destinationCountryCode: string;
  items: Array<{
    sku: string;
    copies: number;
    attributes?: Record<string, string>;
    assets: Array<{ printArea: string }>;
  }>;
  [key: string]: unknown;
}

export interface ProdigiQuoteResponse {
  outcome: string;
  quotes?: Array<{
    shipmentCost?: { amount: string; currency: string };
    [key: string]: unknown;
  }>;
  traceParent?: string;
  [key: string]: unknown;
}

/** POST /products/spine accepts the complete photobook-spine request body. */
export interface ProdigiSpineRequest {
  sku: string;
  destinationCountryCode: string;
  state?: string;
  numberOfPages: number;
  [key: string]: unknown;
}

export interface ProdigiSpineResponse {
  success: boolean;
  message: string;
  spineInfo: { widthMm: number };
}

export interface ProdigiUpdateShippingResponse {
  outcome: 'Updated' | 'PartiallyUpdated' | 'FailedToUpdate' | 'ActionNotAvailable' | string;
  order?: ProdigiOrderResponse['order'];
  traceParent?: string;
}

export interface ProdigiUpdateRecipientResponse {
  outcome: 'Updated' | 'PartiallyUpdated' | 'FailedToUpdate' | 'ActionNotAvailable' | string;
  order?: ProdigiOrderResponse['order'];
  traceParent?: string;
}

export interface ProdigiUpdateMetadataResponse {
  outcome: 'Updated' | 'PartiallyUpdated' | 'FailedToUpdate' | 'ActionNotAvailable' | string;
  order?: ProdigiOrderResponse['order'];
  traceParent?: string;
}

export interface ProdigiUpdateMetadataRequest {
  metadata: Record<string, unknown>;
}

/** GET /orders/{id}/actions — availability of order actions. */
export interface ProdigiOrderActionsResponse {
  outcome: string;
  cancel?: { isAvailable: 'Yes' | 'No' | string };
}

/**
 * POST /orders/{id}/actions/cancel — outcome is 'Cancelled' on success.
 * Prodigi docs disagree with themselves on casing ('Cancelled' in examples,
 * 'cancelled' in the outcomes table) — consumers must compare case-insensitively.
 */
export interface ProdigiCancelResponse {
  outcome: 'Cancelled' | 'FailedToCancel' | 'ActionNotAvailable' | string;
  order?: ProdigiOrderResponse['order'];
}

export interface ProdigiProductResponse {
  product: {
    sku: string;
    variants: Array<{
      printAreaSizes: { default: { horizontalResolution: number; verticalResolution: number } };
    }>;
    attributes: Array<{ name: string; values: string[] }>;
  };
}

export interface FulfilmentJobMessage {
  orderId: string;
  jobId: string;
}
