/* ============================================================
   Header — announcement bar + sticky nav.
   Structural shell. Nav labels come from the i18n catalogs in the
   content phase; placeholders are marked with TODO.
   ============================================================ */
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { Announce } from './Announce';
import { LangSwitch } from './LangSwitch';
import { CartCount } from './CartCount';

export function Header() {
  return (
    <>
      {/* TODO (content): announcement copy */}
      <Announce />

      <header className="header">
        <div className="header-inner">
          {/* TODO (content): nav labels via i18n */}
          <nav className="nav-left">
            <Link className="nav-link" href="/kubki">
              Sklep
            </Link>
            <Link className="nav-link" href="/o-studiu">
              Studio
            </Link>
          </nav>

          <Link className="brand" href="/">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logotype.png" alt="Anna Ciok Ceramics" width={48} height={48} />
            <span className="brand-word">
              ANNA CIOK<small>CERAMICS</small>
            </span>
          </Link>

          <div className="nav-right">
            <Link className="nav-link" href="/kontakt">
              Kontakt
            </Link>
            <LangSwitch />
            <Link className="icon-btn" href="/koszyk" aria-label="Koszyk">
              <Icon name="cart" />
              <CartCount />
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}
