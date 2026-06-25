/* SectionHead — eyebrow + display title pair used across sections. */
import type { ReactNode } from 'react';

type Props = {
  eyebrow?: ReactNode;
  title?: ReactNode;
  /** Optional trailing content (e.g. a section link), right-aligned. */
  aside?: ReactNode;
};

export function SectionHead({ eyebrow, title, aside }: Props) {
  return (
    <div className="section-head">
      <div>
        {eyebrow && <div className="section-eyebrow">{eyebrow}</div>}
        {title && <h2 className="section-title">{title}</h2>}
      </div>
      {aside}
    </div>
  );
}
