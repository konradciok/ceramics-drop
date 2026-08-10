'use client';

/* Line-clamped paragraph with a "read more/less" toggle. The toggle renders
   only when the text actually overflows the clamp (measured on mount), so
   short notes look exactly like the old static <p>. */
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
    if (!el) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text, lines]);

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
