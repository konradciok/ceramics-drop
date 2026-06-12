/* ============================================================
   Footer — 5-column layout (brand + shop + studio + info + contact).
   Server component; translated via next-intl getTranslations.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CATEGORIES, CATEGORY_ORDER } from '@/lib/products';
import { EMAIL } from '@/lib/email-addresses';

export async function Footer() {
  const t = await getTranslations();
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-top cols-5">
          {/* Brand block */}
          <div className="footer-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="flogo" src="/logotype.png" alt="" width={64} height={64} />
            <h4>{t('footer.tagline')}</h4>
            <p>{t('footer.blurb')}</p>
          </div>

          {/* Shop column */}
          <div className="footer-col">
            <h5>{t('footer.hShop')}</h5>
            <ul>
              {CATEGORY_ORDER.map((slug) => (
                <li key={slug}>
                  <Link href={`/${slug}`}>{t(CATEGORIES[slug].nameKey)}</Link>
                </li>
              ))}
              <li>
                <Link href="/koszyk">{t('footer.koszyk')}</Link>
              </li>
            </ul>
          </div>

          {/* Studio column */}
          <div className="footer-col">
            <h5>{t('footer.hStudio')}</h5>
            <ul>
              <li>
                <Link href="/o-studiu">{t('footer.oArtystce')}</Link>
              </li>
              <li>
                <Link href="/gallery">{t('nav.gallery')}</Link>
              </li>
              <li>
                <Link href="/o-studiu#proces">{t('footer.proces')}</Link>
              </li>
              <li>
                <Link href="/kontakt">{t('nav.kontakt')}</Link>
              </li>
            </ul>
          </div>

          {/* Info column */}
          <div className="footer-col">
            <h5>{t('footer.hInfo')}</h5>
            <ul>
              <li>
                <Link href="/dostawa-i-zwroty">{t('footer.dostawa')}</Link>
              </li>
              <li>
                <Link href="/regulamin">{t('footer.regulamin')}</Link>
              </li>
              <li>
                <Link href="/polityka-prywatnosci">{t('footer.polityka')}</Link>
              </li>
            </ul>
          </div>

          {/* Kontakt column */}
          <div className="footer-col">
            <h5>{t('footer.hKontakt')}</h5>
            <ul>
              <li>
                <a href={`mailto:${EMAIL.contact}`}>{EMAIL.contact}</a>
              </li>
              <li>
                <a href="https://instagram.com" target="_blank" rel="noopener noreferrer">
                  Instagram
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom row */}
        <div className="footer-bot">
          <span>{t('footer.copy')}</span>
          <span className="pay">
            <a href="/fonts/Jost-OFL.txt" target="_blank" rel="noopener noreferrer license">
              Font: Jost (OFL)
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
