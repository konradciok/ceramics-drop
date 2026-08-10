/* Native <details>/<summary> accordion stack for PDP info sections — no JS,
   keyboard-accessible. Items with an empty body and no extra node are skipped
   entirely (an admin-emptied CMS field = section disabled). */
import type { ReactNode } from 'react';
import { splitParagraphs } from '@/lib/cms/print-pdp';

export type PdpAccordionItem = {
  key: string;
  title: string;
  body: string;
  /** Optional trailing node (e.g. per-design registry facts) rendered after the body. */
  extra?: ReactNode;
};

export function PdpAccordions({ items }: { items: PdpAccordionItem[] }) {
  const visible = items.filter((item) => item.body.trim() !== '' || item.extra);
  if (visible.length === 0) return null;
  return (
    <div className="pdp-accordions">
      {visible.map((item) => (
        <details key={item.key} className="pdp-acc">
          <summary>{item.title}</summary>
          <div className="pdp-acc-body">
            {splitParagraphs(item.body).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
            {item.extra}
          </div>
        </details>
      ))}
    </div>
  );
}
