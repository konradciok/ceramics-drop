export type ReturnStatusKey = 'success' | 'ineligible' | 'unavailable' | 'rateLimited' | 'error';

/** Map the /api/returns HTTP status to a localized message key. */
export function returnStatusMessageKey(status: number): ReturnStatusKey {
  if (status === 200) return 'success';
  if (status === 404) return 'ineligible';
  if (status === 429) return 'rateLimited';
  if (status === 503) return 'unavailable';
  return 'error';
}
