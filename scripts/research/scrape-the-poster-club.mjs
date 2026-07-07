#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const outDir = resolve(repoRoot, process.argv[2] || 'docs/research/the-poster-club/raw');
const BASE = 'https://theposterclub.com';
const UA = 'Mozilla/5.0 (compatible; ceramics-drop-research/1.0; +https://anna-ciok.studio)';
const IMPORTANT_COLLECTIONS = [
  { label: 'All Artworks', handle: 'all-art' },
  { label: 'Art Prints', handle: 'art-prints' },
  { label: 'Wall Objects', handle: 'wall-objects' },
  { label: 'Canvas Art', handle: 'canvas' },
  { label: 'New Arrivals', handle: 'new-arrivals' },
  { label: 'Bestsellers', handle: 'bestsellers' },
  { label: 'XL Art Prints', handle: 'xl-art-prints-1' },
];
const SAMPLE_PRODUCTS = [
  { key: 'print', handle: 'suzanne-lustig-perfect-together' },
  { key: 'canvas', handle: 'canvas-rebecca-hein-the-line-red' },
  { key: 'wall_object', handle: 'thalia-vase' },
];

mkdirSync(outDir, { recursive: true });

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function topEntries(map, limit = 15) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function histogram(values) {
  return values.reduce((acc, value) => {
    const key = String(value);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function parseLocs(xml) {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1].replace(/&amp;/g, '&'));
}

function textMatch(html, regex) {
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}

function parseJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const parsed = [];
  for (const block of blocks) {
    try {
      parsed.push(JSON.parse(block));
    } catch {}
  }
  return parsed;
}

async function fetchAllProductsForCollection(handle) {
  const products = [];
  const pageSizes = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `${BASE}/collections/${handle}/products.json?limit=250&page=${page}`;
    const payload = await fetchJson(url);
    const batch = payload.products || [];
    products.push(...batch);
    pageSizes.push(batch.length);
    if (batch.length < 250) break;
  }
  return { products, pageSizes };
}

function summarizeProducts(products) {
  const productTypes = {};
  const vendors = {};
  const tags = {};
  const prices = [];
  const variantCounts = [];
  const optionNames = {};

  for (const product of products) {
    const productType = product.product_type || 'Unknown';
    const vendor = product.vendor || 'Unknown';
    productTypes[productType] = (productTypes[productType] || 0) + 1;
    vendors[vendor] = (vendors[vendor] || 0) + 1;
    variantCounts.push(product.variants?.length || 0);
    for (const variant of product.variants || []) {
      if (typeof variant.price === 'string' || typeof variant.price === 'number') {
        prices.push(Number(variant.price));
      }
    }
    for (const tag of product.tags || []) {
      tags[tag] = (tags[tag] || 0) + 1;
    }
    for (const option of product.options || []) {
      optionNames[option.name] = (optionNames[option.name] || 0) + 1;
    }
  }

  return {
    totalProducts: products.length,
    productTypes: topEntries(productTypes, 20),
    topVendors: topEntries(vendors, 20),
    topTags: topEntries(tags, 30),
    optionNameFrequency: topEntries(optionNames, 20),
    priceRange: prices.length
      ? { min: Math.min(...prices), max: Math.max(...prices) }
      : null,
    variantCountHistogram: topEntries(histogram(variantCounts), 20),
  };
}

async function fetchCollectionPageMeta(handle) {
  const html = await fetchText(`${BASE}/collections/${handle}`);
  const jsonLd = parseJsonLd(html);
  const collectionPage = jsonLd
    .flatMap((entry) => entry['@graph'] || [entry])
    .find((entry) => entry['@type'] === 'CollectionPage');
  const itemList = jsonLd
    .flatMap((entry) => entry['@graph'] || [entry])
    .find((entry) => entry['@type'] === 'ItemList');

  return {
    title: textMatch(html, /<title>(.*?)<\/title>/is),
    canonical: textMatch(html, /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i),
    metaDescription: textMatch(html, /<meta[^>]+name="description"[^>]+content="([^"]+)"/i),
    collectionDescription: collectionPage?.description || null,
    jsonLdItemCount: itemList?.numberOfItems || null,
    jsonLdPreview: (itemList?.itemListElement || []).slice(0, 8).map((item) => ({
      position: item.position,
      name: item.item?.name,
      url: item.item?.url,
      offerCount: item.item?.offers?.offerCount,
      lowPrice: item.item?.offers?.lowPrice,
      highPrice: item.item?.offers?.highPrice,
      availability: item.item?.offers?.availability,
    })),
  };
}

async function fetchSampleProduct(handle) {
  const product = await fetchJson(`${BASE}/products/${handle}.js`);
  const html = await fetchText(`${BASE}/products/${handle}`);
  const jsonLd = parseJsonLd(html);
  const graph = jsonLd.flatMap((entry) => entry['@graph'] || [entry]);
  const productGroup = graph.find((entry) => entry['@type'] === 'ProductGroup');
  const breadcrumbs = graph.find((entry) => entry['@type'] === 'BreadcrumbList');

  return {
    handle: product.handle,
    title: product.title,
    vendor: product.vendor,
    type: product.type,
    tags: product.tags,
    priceMin: product.price_min / 100,
    priceMax: product.price_max / 100,
    variantCount: product.variants.length,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      title: variant.public_title || variant.title,
      available: variant.available,
      price: variant.price / 100,
      sku: variant.sku,
      option1: variant.option1,
      option2: variant.option2,
      option3: variant.option3,
    })),
    optionNames: (product.options_with_values || []).map((option) => ({
      name: option.name,
      values: option.values,
    })),
    imageCount: product.images.length,
    images: product.images.slice(0, 10),
    descriptionText: stripHtml(product.description),
    seo: {
      title: textMatch(html, /<title>(.*?)<\/title>/is),
      metaDescription: textMatch(html, /<meta[^>]+name="description"[^>]+content="([^"]+)"/i),
      canonical: textMatch(html, /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i),
    },
    jsonLd: {
      category: productGroup?.category || null,
      variesBy: productGroup?.variesBy || null,
      hasVariantCount: productGroup?.hasVariant?.length || 0,
      breadcrumbs: (breadcrumbs?.itemListElement || []).map((item) => ({
        position: item.position,
        name: item.name,
        item: item.item,
      })),
    },
  };
}

const sitemapXml = await fetchText(`${BASE}/sitemap.xml`);
const sitemapUrls = parseLocs(sitemapXml);
const collectionsSitemapUrl = sitemapUrls.find((url) => url.includes('sitemap_collections_1.xml'));
const collectionsXml = await fetchText(collectionsSitemapUrl);
const collectionUrls = parseLocs(collectionsXml);

const collectionSummaries = [];
for (const collection of IMPORTANT_COLLECTIONS) {
  const meta = await fetchCollectionPageMeta(collection.handle);
  const { products, pageSizes } = await fetchAllProductsForCollection(collection.handle);
  collectionSummaries.push({
    label: collection.label,
    handle: collection.handle,
    url: `${BASE}/collections/${collection.handle}`,
    pageSizes,
    meta,
    summary: summarizeProducts(products),
    productPreview: products.slice(0, 12).map((product) => ({
      handle: product.handle,
      title: product.title,
      vendor: product.vendor,
      type: product.product_type,
      priceMin: Number(product.variants?.[0]?.price ?? 0),
      variantCount: product.variants?.length || 0,
      tags: product.tags?.slice(0, 8) || [],
    })),
  });
}

const samplePdps = {};
for (const sample of SAMPLE_PRODUCTS) {
  samplePdps[sample.key] = await fetchSampleProduct(sample.handle);
}

const output = {
  generatedAt: new Date().toISOString(),
  source: BASE,
  sitemap: {
    index: sitemapUrls,
    collectionsSitemapUrl,
    collectionUrls,
  },
  collections: collectionSummaries,
  samplePdps,
};

writeFileSync(resolve(outDir, 'poster-club-sitemap.json'), JSON.stringify(output.sitemap, null, 2));
writeFileSync(resolve(outDir, 'poster-club-collections.json'), JSON.stringify(output.collections, null, 2));
writeFileSync(resolve(outDir, 'poster-club-sample-pdps.json'), JSON.stringify(output.samplePdps, null, 2));
writeFileSync(resolve(outDir, 'poster-club-research.json'), JSON.stringify(output, null, 2));

console.log(JSON.stringify({
  outDir,
  collectionCount: output.sitemap.collectionUrls.length,
  importantCollections: output.collections.map((item) => ({
    handle: item.handle,
    totalProducts: item.summary.totalProducts,
    productTypes: item.summary.productTypes.slice(0, 3),
    priceRange: item.summary.priceRange,
  })),
  samplePdps: Object.fromEntries(Object.entries(output.samplePdps).map(([key, value]) => [key, {
    title: value.title,
    type: value.type,
    variantCount: value.variantCount,
    priceMin: value.priceMin,
    priceMax: value.priceMax,
  }])),
}, null, 2));
