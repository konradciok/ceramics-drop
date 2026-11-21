import { describe, expect, it } from 'vitest';
import { GET as google } from './route';
import { GET as meta } from '../meta/route';

describe('retired merchant feeds', () => {
  it.each([
    ['google', google],
    ['meta', meta],
  ])('%s answers 410 Gone and points at the print shop', async (_name, handler) => {
    const res = handler();
    expect(res.status).toBe(410);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'feed_retired', moved_to: 'https://anna-ciok.com' });
  });
});
