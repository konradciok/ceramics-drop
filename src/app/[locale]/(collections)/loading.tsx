export default function Loading() {
  return (
    <>
      <span className="sr-only" role="status">Loading…</span>
      <div className="gallery skel-gallery" aria-hidden="true">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="skel-tile" />
        ))}
      </div>
    </>
  );
}
