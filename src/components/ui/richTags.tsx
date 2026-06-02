import type { ReactNode } from 'react';

/**
 * Tag renderers for next-intl `t.rich(...)`. Mirrors the inline HTML the
 * design copy uses (em accents, strong, b, line breaks). For inline links,
 * spread this and add a `link` renderer at the call site (see plan R2).
 */
export const richTags = {
  em: (chunks: ReactNode) => <em>{chunks}</em>,
  strong: (chunks: ReactNode) => <strong>{chunks}</strong>,
  b: (chunks: ReactNode) => <b>{chunks}</b>,
  br: () => <br />,
};
