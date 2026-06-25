/* Marquee — slow horizontal scroller on espresso. Content TBD. */
type Props = {
  /** Repeated phrase segments; duplicated for a seamless loop. */
  items?: string[];
};

export function Marquee({ items = [] }: Props) {
  const line = (
    <span>
      {items.map((text, i) => (
        <span key={i}>
          {text}
          <span className="md" />
        </span>
      ))}
    </span>
  );

  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {line}
        {line}
      </div>
    </div>
  );
}
