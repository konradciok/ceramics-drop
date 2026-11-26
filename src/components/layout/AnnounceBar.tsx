/**
 * Announcement bar (server component). Not mounted since its print-shop
 * pointer was removed (2026-11); T8 in
 * docs/plans/2026-11-25-conversion-audit-action-plan.md brings it back for
 * the live drop. A plain `<a>` so it can also point at another origin.
 */
type Props = { text: string; href: string };

export function AnnounceBar({ text, href }: Props) {
  return (
    <div className="announce">
      <span className="dot" />
      <a href={href} className="announce-link">
        {text}
      </a>
      <span className="dot" />
    </div>
  );
}
