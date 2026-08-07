import { PRINT_DESIGNS } from '../../src/lib/prints';
import { registryProductsByCategory } from '../../src/lib/products';

const categories = process.argv.slice(2);

if (categories.length === 0) {
  throw new Error('At least one category slug is required.');
}

// Uses the sync registry helpers (not the async CATALOG_SOURCE-aware accessors):
// this is a code-derived tooling script (notes:generate) that must stay
// synchronous, and the registries are its intended source.
const payload = Object.fromEntries(
  categories.map((category) => {
    // Prints live in their own registry; only published designs get notes
    // (their sparse noteIndexes skip the withdrawn legacy posters' slots 0-2).
    if (category === 'fine-art-prints') {
      return [category, PRINT_DESIGNS.filter((design) => design.published)];
    }
    const products = registryProductsByCategory(category as Parameters<typeof registryProductsByCategory>[0]);
    if (!products) {
      throw new Error(`Unknown category slug: "${category}". Check CATEGORY_ORDER in src/lib/products.ts for valid slugs.`);
    }
    return [category, products];
  }),
);

process.stdout.write(JSON.stringify(payload));
