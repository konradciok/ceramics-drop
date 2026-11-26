import { Link } from '@/i18n/navigation';

/**
 * Announcement bar (server component). During a drop it points every page at
 * the shop (`/sklep`); the locale-aware Link keeps `/en`, `/es`, `/de`
 * visitors in their language. The separate print shop keeps its links in the
 * header nav and the footer.
 */
type Props = { text: string; href: string };

export function AnnounceBar({ text, href }: Props) {
  return (
    <div className="announce" data-testid="announce">
      <span className="dot" />
      <Link href={href} className="announce-link">
        {text}
      </Link>
      <span className="dot" />
    </div>
  );
}
