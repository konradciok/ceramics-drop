import { getProductsByCategory } from '../../src/lib/products';

const categories = process.argv.slice(2);

if (categories.length === 0) {
  throw new Error('At least one category slug is required.');
}

const payload = Object.fromEntries(
  categories.map((category) => {
    const products = getProductsByCategory(category as Parameters<typeof getProductsByCategory>[0]);
    if (!products) {
      throw new Error(`Unknown category slug: "${category}". Check CATEGORY_ORDER in src/lib/products.ts for valid slugs.`);
    }
    return [category, products];
  }),
);

process.stdout.write(JSON.stringify(payload));
