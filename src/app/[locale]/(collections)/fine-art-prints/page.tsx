// Legacy collection entry; next.config.ts issues the public 308 redirect.
// Reuse the canonical page for internal rewrites without duplicating the catalogue.
export { default, generateMetadata } from '../sklep/page';
export const dynamic = 'force-dynamic';
