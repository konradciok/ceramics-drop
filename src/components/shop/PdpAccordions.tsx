/* Native <details>/<summary> accordion stack for PDP info sections — no JS,
   keyboard-accessible. An item renders only when its body is non-empty; an
   admin-emptied CMS field hides the whole section, including any extra
   (e.g. per-design registry facts) that would otherwise ride along with it. */
import type { ReactNode } from 'react';
import { splitParagraphs } from '@/lib/cms/print-pdp';

export type PdpAccordionItem = {
  key: string;
  title: string;
  body: string;
  /** Optional trailing node (e.g. per-design registry facts) rendered after the body — only ever shown alongside a non-empty body, never on its own. */
  extra?: ReactNode;
};

export function PdpAccordions({ items }: { items: PdpAccordionItem[] }) {
  const visible = items.filter((item) => item.body.trim() !== '');
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
