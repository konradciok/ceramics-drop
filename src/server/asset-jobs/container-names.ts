/**
 * Shared constants for addressing the print-asset Container's Durable Object.
 *
 * Kept in their own module (rather than in container.ts) for one reason: the
 * queue consumer needs the instance name, and container.ts imports
 * `cloudflare:workers`, which cannot be resolved by the app tsconfig or by
 * vitest's node environment. Importing the name from here keeps
 * process-job.ts — and its tests — free of that dependency.
 */

/**
 * The single fixed Durable Object instance name every job funnels through.
 * Combined with wrangler.jsonc's `max_instances: 1` this is the master plan's
 * "jedna instancja `standard-3`, jedno zadanie naraz" (one standard-3
 * instance, one job at a time).
 */
export const PRINT_ASSET_PROCESSOR_NAME = 'print-asset-processor';
