import { registryProductsByCategory } from '../../src/lib/products';

const categories = process.argv.slice(2);

if (categories.length === 0) {
  throw new Error('At least one category slug is required.');
}

// Uses the sync registry helper (not the async CATALOG_SOURCE-aware accessor):
// this is a code-derived tooling script (notes:generate) that must stay
// synchronous, and the registry is its intended source.
const payload = Object.fromEntries(
  categories.map((category) => {
    const products = registryProductsByCategory(category as Parameters<typeof registryProductsByCategory>[0]);
    if (!products) {
      throw new Error(`Unknown category slug: "${category}". Check CATEGORY_ORDER in src/lib/products.ts for valid slugs.`);
    }
    return [category, products];
  }),
);

process.stdout.write(JSON.stringify(payload));
