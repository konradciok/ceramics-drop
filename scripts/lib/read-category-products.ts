import { getProductsByCategory } from '../../src/lib/products';

const categories = process.argv.slice(2);

if (categories.length === 0) {
  throw new Error('At least one category slug is required.');
}

const payload = Object.fromEntries(
  categories.map((category) => [category, getProductsByCategory(category as Parameters<typeof getProductsByCategory>[0])]),
);

process.stdout.write(JSON.stringify(payload));
