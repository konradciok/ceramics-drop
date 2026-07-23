/* ============================================================
   Header — announcement bar + sticky nav (server component).
   Mobile navigation is handled by the MobileMenu client island.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { LangSwitch } from './LangSwitch';
import { CurrencySwitcher } from './CurrencySwitcher';
import { CartCount } from './CartCount';
import { MobileMenu } from './MobileMenu';

export async function Header() {
  const t = await getTranslations();

  const mobileLinks = [
    { href: '/sklep', label: t('nav.sklep') },
    { href: '/showroom', label: t('nav.showroom') },
    { href: '/gallery', label: t('nav.gallery') },
    { href: '/o-studiu', label: t('nav.studio') },
    { href: '/kontakt', label: t('nav.kontakt') },
    { href: '/konto', label: t('nav.konto') },
  ];

  const mobileAria = {
    open: t('aria.openMenu'),
    close: t('aria.closeMenu'),
    nav: t('aria.menuLabel'),
  };

  return (
    <>
      <div className="announce"><span className="dot" />{t('announce')}<span className="dot" /></div>

      <header id="site-header" className="header">
        <div className="header-inner">
          {/* Desktop: nav links. Mobile: hamburger trigger (MobileMenu renders it). */}
          <nav className="nav-left">
            <Link className="nav-link" href="/sklep">{t('nav.sklep')}</Link>
            <Link className="nav-link" href="/showroom">{t('nav.showroom')}</Link>
            <Link className="nav-link" href="/gallery">{t('nav.gallery')}</Link>
            <Link className="nav-link" href="/o-studiu">{t('nav.studio')}</Link>
          </nav>
          <MobileMenu links={mobileLinks} aria={mobileAria} />

          <Link className="brand" href="/">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logotype.png" alt="Anna Ciok Ceramics" width={48} height={48} />
            <span className="brand-word">ANNA CIOK<small>CERAMICS</small></span>
          </Link>

          <div className="nav-right">
            <Link className="nav-link" href="/kontakt">{t('nav.kontakt')}</Link>
            <LangSwitch />
            <CurrencySwitcher />
            {/* Deliberately static (not session-aware): reading cookies here
                would flip the prerenderable Polish tree dynamic. /konto itself
                shows the right signed-in/out state. */}
            <Link className="icon-btn" href="/konto" aria-label={t('nav.konto')} data-testid="nav-konto">
              <Icon name="user" />
            </Link>
            <Link className="icon-btn" href="/koszyk" aria-label={t('aria.cart')}>
              <Icon name="cart" />
              <CartCount />
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}
