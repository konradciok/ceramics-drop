import { describe, expect, it } from 'vitest';
import { withEmailUtm } from './email-utm';

describe('withEmailUtm', () => {
  it('tags a bare storefront URL for the GA4 Email channel', () => {
    expect(withEmailUtm('https://anna-ciok.studio/en/koszyk', 'transactional', 'abandoned_checkout')).toBe(
      'https://anna-ciok.studio/en/koszyk?utm_source=transactional&utm_medium=email&utm_campaign=abandoned_checkout',
    );
  });

  it('keeps existing query params, such as a capability token', () => {
    const url = new URL(withEmailUtm('https://anna-ciok.studio/zwrot?order=abc-123', 'transactional', 'order_shipped'));
    expect(url.searchParams.get('order')).toBe('abc-123');
    expect(url.searchParams.get('utm_medium')).toBe('email');
    expect(url.searchParams.get('utm_campaign')).toBe('order_shipped');
  });
});
