import { describe, it, expect } from 'vitest';
import { readBodyLimited } from './read-body-limited';

function streamed(chunks: string[], headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Request('https://example.test/hook', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
}

describe('readBodyLimited', () => {
  it('returns the body when it fits', async () => {
    await expect(readBodyLimited(streamed(['{"a":', '1}']), 16)).resolves.toBe('{"a":1}');
    await expect(readBodyLimited(new Request('https://example.test/hook', { method: 'POST' }), 16)).resolves.toBe('');
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('żółw');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1));
        controller.close();
      },
    });
    const req = new Request('https://example.test/hook', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await expect(readBodyLimited(req, 64)).resolves.toBe('żółw');
  });

  it('stops once the streamed bytes exceed the limit, whatever the header says', async () => {
    await expect(readBodyLimited(streamed(['12345', '67890']), 8)).resolves.toBeNull();
    await expect(readBodyLimited(streamed(['12345', '67890'], { 'content-length': '4' }), 8)).resolves.toBeNull();
  });

  it('refuses a declared Content-Length over the limit up front', async () => {
    await expect(readBodyLimited(streamed(['x'], { 'content-length': '9999' }), 8)).resolves.toBeNull();
  });
});
