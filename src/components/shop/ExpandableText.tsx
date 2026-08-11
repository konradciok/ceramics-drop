'use client';

/* Line-clamped paragraph with a "read more/less" toggle. The toggle renders
   only when the text actually overflows the clamp, re-measured via
   ResizeObserver so a later viewport resize or webfont swap that pushes
   text past the clamp still surfaces the toggle — not just the initial
   mount — so short notes look exactly like the old static <p>. */
import { useLayoutEffect, useRef, useState } from 'react';

export function ExpandableText({
  text,
  lines = 4,
  moreLabel,
  lessLabel,
  className,
}: {
  text: string;
  lines?: number;
  moreLabel: string;
  lessLabel: string;
  className?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    // While expanded the toggle stays visible regardless of clamped state,
    // so there's nothing to re-measure until the user collapses it again.
    if (!el || expanded) return;

    const measure = () => {
      setClamped(el.scrollHeight > el.clientHeight + 1);
    };

    measure();

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, lines, expanded]);

  return (
    <div className="x-text">
      <p
        ref={ref}
        className={className}
        style={
          expanded
            ? undefined
            : { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines, overflow: 'hidden' }
        }
      >
        {text}
      </p>
      {(clamped || expanded) && (
        <button type="button" className="x-text-toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  );
}
