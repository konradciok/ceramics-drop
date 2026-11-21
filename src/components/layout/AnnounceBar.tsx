/**
 * Announcement bar (server component). Currently points visitors who come
 * looking for fine-art prints to the print shop they moved to (2026-11).
 * A plain `<a>`: the target is another origin, so the i18n Link would only
 * get in the way.
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
