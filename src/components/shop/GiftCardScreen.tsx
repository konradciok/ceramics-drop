/* ============================================================
   GiftCardScreen — gift-card PDP layout (server component).
   Mirrors PrintProductScreen's chrome (breadcrumb, heading, accordions,
   About-the-Artist band) but has no product gallery/variant matrix: the
   GiftCardConfigurator client island owns the tier picker AND the dedicated
   single-item checkout (see its file header for why it doesn't route through
   the general /koszyk cart).
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { SITE_NAME } from '@/lib/site';
import { GiftCardConfigurator } from './GiftCardConfigurator';
import { PdpAccordions } from './PdpAccordions';
import { AboutArtistSection } from './AboutArtistSection';
import { PRINT_PDP_ARTIST_IMAGE } from '@/lib/editorial-images';
import type { PrintPdpPayload } from '@/lib/cms/types';

export async function GiftCardScreen({ content }: { content: PrintPdpPayload }) {
  const t = await getTranslations();

  return (
    <article className="pdp giftcard-pdp">
      <div className="pdp-inner">
        <nav className="pdp-breadcrumb" aria-label="breadcrumb">
          <Link href="/">{SITE_NAME}</Link>
          <span className="pdp-breadcrumb-sep" aria-hidden="true">/</span>
          <span aria-current="page">{t('giftCard.h1')}</span>
        </nav>

        <div className="giftcard-panel">
          <div className="giftcard-hero" aria-hidden="true">
            <span className="giftcard-hero-brand">{SITE_NAME}</span>
            <span className="giftcard-hero-label">{t('giftCard.h1')}</span>
          </div>

          <div className="pdp-body">
            <div className="eyebrow">{t('giftCard.eyebrow')}</div>
            <h1>{t('giftCard.h1')}</h1>
            <p className="pdp-note">{t('giftCard.lead')}</p>

            <GiftCardConfigurator />

            <PdpAccordions
              items={[
                {
                  key: 'howItWorks',
                  title: t('giftCard.accordionHowTitle'),
                  body: t('giftCard.accordionHowBody'),
                },
                {
                  key: 'terms',
                  title: t('giftCard.accordionTermsTitle'),
                  body: t('giftCard.accordionTermsBody'),
                },
              ]}
            />
          </div>
        </div>
      </div>

      <AboutArtistSection
        title={t('printPdp.aboutArtistTitle')}
        name={content.artist.name}
        bio={content.artist.bio}
        image={PRINT_PDP_ARTIST_IMAGE}
      />
    </article>
  );
}
