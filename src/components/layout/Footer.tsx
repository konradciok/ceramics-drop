/* ============================================================
   Footer — 5-column shell (brand + shop + studio + info + contact).
   Structural only; link labels / copy come from i18n in the
   content phase. Routes are already wired.
   ============================================================ */
import { Link } from '@/i18n/navigation';
import { CATEGORY_ORDER } from '@/lib/products';

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-top cols-5">
          <div className="footer-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="flogo" src="/logotype.png" alt="" width={64} height={64} />
            {/* TODO (content): tagline + blurb */}
            <h4 />
            <p />
          </div>

          <div className="footer-col">
            <h5>Sklep</h5>
            <ul>
              {CATEGORY_ORDER.map((slug) => (
                <li key={slug}>
                  {/* TODO (content): category label via i18n */}
                  <Link href={`/${slug}`}>{slug}</Link>
                </li>
              ))}
              <li>
                <Link href="/koszyk">Koszyk</Link>
              </li>
            </ul>
          </div>

          <div className="footer-col">
            <h5>Studio</h5>
            <ul>
              <li>
                <Link href="/o-studiu">O studiu</Link>
              </li>
              <li>
                <Link href="/kontakt">Kontakt</Link>
              </li>
            </ul>
          </div>

          <div className="footer-col">
            <h5>Informacje</h5>
            <ul>
              <li>
                <Link href="/dostawa-i-zwroty">Dostawa i zwroty</Link>
              </li>
              <li>
                <Link href="/regulamin">Regulamin</Link>
              </li>
              <li>
                <Link href="/polityka-prywatnosci">Polityka prywatności</Link>
              </li>
            </ul>
          </div>

          <div className="footer-col">
            <h5>Kontakt</h5>
            <ul>
              <li>
                <a href="mailto:hej@annaciok.pl">hej@annaciok.pl</a>
              </li>
              <li>
                <a href="https://instagram.com" target="_blank" rel="noopener noreferrer">
                  Instagram
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* TODO (content): copyright + payment row */}
        <div className="footer-bot" />
      </div>
    </footer>
  );
}
