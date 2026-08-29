/* ============================================================
   Footer — PSTR-style: logo row, newsletter + social on the left,
   four link sections (static columns ≥861px, accordions below).
   Server component; translated via next-intl getTranslations.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CATEGORIES, VISIBLE_CATEGORY_ORDER } from '@/lib/products';
import { EMAIL } from '@/lib/email-addresses';
import { FooterNewsletterForm } from './FooterNewsletterForm';
import { FooterAccordionSection } from './FooterAccordionSection';
import { PaymentBadges } from './PaymentBadges';

const INSTAGRAM_URL = 'https://www.instagram.com/anna.ciok.art/';

export async function Footer() {
  const t = await getTranslations();
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-head">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="flogo" src="/logotype.png" alt="" width={64} height={64} />
        </div>

        <div className="footer-top">
          <div className="footer-news">
            <FooterNewsletterForm />
          </div>

          {/* Ceramics section */}
          <FooterAccordionSection id="fshop" heading={t('footer.hShop')}>
            <ul>
              {VISIBLE_CATEGORY_ORDER.map((slug) => (
                <li key={slug}>
                  <Link href={`/${slug}`}>{t(CATEGORIES[slug].nameKey)}</Link>
                </li>
              ))}
            </ul>
          </FooterAccordionSection>

          {/* Painting / prints section */}
          <FooterAccordionSection id="fart" heading={t('footer.hArt')}>
            <ul>
              <li>
                <Link href="/fine-art-prints">{t('nav.fineArtPrints')}</Link>
              </li>
              <li>
                <Link href="/gallery">{t('nav.gallery')}</Link>
              </li>
              <li>
                <Link href="/koszyk">{t('footer.koszyk')}</Link>
              </li>
            </ul>
          </FooterAccordionSection>

          {/* Studio section */}
          <FooterAccordionSection id="fstudio" heading={t('footer.hStudio')}>
            <ul>
              <li>
                <Link href="/o-studiu">{t('footer.oArtystce')}</Link>
              </li>
              <li>
                <Link href="/o-studiu#proces">{t('footer.proces')}</Link>
              </li>
              <li>
                <Link href="/kontakt">{t('nav.kontakt')}</Link>
              </li>
              <li>
                <a href={`mailto:${EMAIL.contact}`}>{EMAIL.contact}</a>
              </li>
            </ul>
          </FooterAccordionSection>

          {/* Info section */}
          <FooterAccordionSection id="finfo" heading={t('footer.hInfo')}>
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
          </FooterAccordionSection>

          <div className="footer-social">
            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Instagram"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <rect x="2.5" y="2.5" width="19" height="19" rx="5" />
                <circle cx="12" cy="12" r="4.5" />
                <circle cx="17.6" cy="6.4" r="1.2" fill="currentColor" stroke="none" />
              </svg>
            </a>
          </div>
        </div>

        {/* Bottom row */}
        <div className="footer-bot">
          <PaymentBadges />
          <span className="footer-legal">
            {t('footer.copy')} ·{' '}
            <a href="/fonts/Jost-OFL.txt" target="_blank" rel="noopener noreferrer license">
              Font: Jost (OFL)
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
