import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const mocks = vi.hoisted(() => ({
  resolveCartLinesServer: vi.fn(),
}));
vi.mock('@/lib/cart-lines-server', () => ({
  resolveCartLinesServer: mocks.resolveCartLinesServer,
}));

function req(url: string) {
  return new Request(url);
}

describe('GET /api/cart-lines', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400s when ids is missing', async () => {
    const res = await GET(req('http://localhost/api/cart-lines'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'ids required' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.resolveCartLinesServer).not.toHaveBeenCalled();
  });

  it('400s when ids is present but empty', async () => {
    const res = await GET(req('http://localhost/api/cart-lines?ids='));
    expect(res.status).toBe(400);
    expect(mocks.resolveCartLinesServer).not.toHaveBeenCalled();
  });

  it('400s when locale is invalid', async () => {
    const res = await GET(req('http://localhost/api/cart-lines?ids=k01&locale=invalid'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_locale' });
    expect(mocks.resolveCartLinesServer).not.toHaveBeenCalled();
  });

  it('drops empty segments from a trailing/leading/doubled comma', async () => {
    mocks.resolveCartLinesServer.mockResolvedValue([]);
    await GET(req('http://localhost/api/cart-lines?ids=k01,,k02,'));
    expect(mocks.resolveCartLinesServer).toHaveBeenCalledWith(['k01', 'k02'], 'pl');
  });

  it('passes the parsed ids through and returns the resolver output with no-store', async () => {
    const lines = [
      { kind: 'ceramic', id: 'k01', product: { id: 'k01' } },
      { kind: 'unavailable', id: 'nope' },
    ];
    mocks.resolveCartLinesServer.mockResolvedValue(lines);
    const res = await GET(req('http://localhost/api/cart-lines?ids=k01,nope'));
    expect(mocks.resolveCartLinesServer).toHaveBeenCalledWith(['k01', 'nope'], 'pl');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ lines });
  });

  it('url-decodes ids (e.g. an encoded print token) before passing them to the resolver', async () => {
    mocks.resolveCartLinesServer.mockResolvedValue([]);
    const token = 'print:fap005:50x70:true:false:black';
    await GET(req(`http://localhost/api/cart-lines?ids=${encodeURIComponent(token)}`));
    expect(mocks.resolveCartLinesServer).toHaveBeenCalledWith([token], 'pl');
  });

  it('passes through a valid locale parameter', async () => {
    mocks.resolveCartLinesServer.mockResolvedValue([]);
    await GET(req('http://localhost/api/cart-lines?ids=k01&locale=en'));
    expect(mocks.resolveCartLinesServer).toHaveBeenCalledWith(['k01'], 'en');
  });
});
