/* eslint-disable */
// Minimal Workers binding types for cloudflare-env.d.ts when cf-typegen runs with
// --include-runtime=false. Full handler/runtime types live in tsconfig.worker.json
// (@cloudflare/workers-types). Pin that package in devDependencies — do not rely on
// wrangler's transitive optional peer alone.

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface Queue {
  send(message: unknown, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Iterable<{ body: unknown; delaySeconds?: number }>): Promise<void>;
}

interface R2HTTPMetadata {
  contentType?: string;
}

interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly httpEtag: string;
  readonly httpMetadata?: R2HTTPMetadata;
}

interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
}

interface Service<_T = unknown> {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
