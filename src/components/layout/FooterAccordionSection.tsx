'use client';

import { useState } from 'react';
import { useMediaQuery } from '@/lib/use-media-query';

type Props = {
  id: string;
  heading: string;
  children: React.ReactNode;
};

/**
 * One footer link section: a static always-open column at ≥861px, a
 * collapsed-by-default accordion below. Sections own their state, so several
 * can be open at once. SSR renders the button variant (useMediaQuery's server
 * snapshot is false); at desktop widths the CSS styles both variants
 * identically and forces the panel open, so the post-hydration swap to a real
 * <h5> is invisible — only the semantics change.
 */
export function FooterAccordionSection({ id, heading, children }: Props) {
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 861px)');

  return (
    <section className="facc">
      {isDesktop ? (
        <h5 className="facc-head">{heading}</h5>
      ) : (
        <button
          type="button"
          className="facc-head"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          onClick={() => setOpen((o) => !o)}
        >
          {heading}
          <span className="facc-icon" aria-hidden="true" />
        </button>
      )}
      <div id={`${id}-panel`} className="facc-panel" data-open={open || isDesktop}>
        <div className="facc-panel-inner">{children}</div>
      </div>
    </section>
  );
}
