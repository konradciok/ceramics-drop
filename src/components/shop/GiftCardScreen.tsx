/* ============================================================
   GiftCardScreen — gift card PDP layout (server component).
   Editorial hero + denomination/gift-form island + how-it-works +
   info accordions + the shared About-the-Artist band (same CMS content
   as the print PDP). No cart/checkout wiring yet — see GiftCardConfigurator.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { richTags } from '@/components/ui/richTags';
import { PdpAccordions } from './PdpAccordions';
import { AboutArtistSection } from './AboutArtistSection';
import { GiftCardConfigurator } from './GiftCardConfigurator';
import { PRINT_PDP_ARTIST_IMAGE } from '@/lib/editorial-images';
import type { PrintPdpPayload } from '@/lib/cms/types';

export async function GiftCardScreen({ artistContent }: { artistContent: PrintPdpPayload }) {
  const t = await getTranslations('giftCard');
  const tPrintPdp = await getTranslations('printPdp');

  return (
    <main>
      <section className="gc-hero">
        <div className="gc-hero-inner">
          <div className="gc-hero-copy">
            <span className="eyebrow">{t('eyebrow')}</span>
            <h1>{t.rich('h1', richTags)}</h1>
            <p>{t('lead')}</p>
          </div>
          <div className="gc-card-wrap">
            <div className="gc-card">
              <div className="gc-card-top">
                <span className="gc-card-mark">ANNA CIOK</span>
                <div className="gc-card-dots">
                  <span /><span /><span />
                </div>
              </div>
              <div className="gc-card-mid">
                <div className="l1">{t('cardLabel')}</div>
              </div>
              <div className="gc-card-bottom">{t('cardValidity')}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="gc-band">
        <div className="gc-band-inner">
          <div className="gc-band-head">
            <span className="section-eyebrow">{t('amountEyebrow')}</span>
            <h2 className="section-title">{t('amountTitle')}</h2>
          </div>
          <GiftCardConfigurator />
        </div>
      </section>

      <section className="gc-steps">
        <div className="gc-steps-inner">
          <div className="gc-steps-head">
            <span className="section-eyebrow">{t('stepsEyebrow')}</span>
            <h2 className="section-title">{t('stepsTitle')}</h2>
          </div>
          <div className="gc-steps-grid">
            <div className="gc-step">
              <div className="num">01</div>
              <h4>{t('step1H')}</h4>
              <p>{t('step1P')}</p>
            </div>
            <div className="gc-step">
              <div className="num">02</div>
              <h4>{t('step2H')}</h4>
              <p>{t('step2P')}</p>
            </div>
            <div className="gc-step">
              <div className="num">03</div>
              <h4>{t('step3H')}</h4>
              <p>{t('step3P')}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="gc-acc-section">
        <div className="gc-acc-inner">
          <div className="gc-acc-head">
            <span className="section-eyebrow">{t('detailsEyebrow')}</span>
            <h2 className="section-title">{t('detailsTitle')}</h2>
          </div>
          <PdpAccordions
            items={[
              { key: 'validity', title: t('accValidityTitle'), body: t('accValidityBody') },
              { key: 'howTo', title: t('accHowToTitle'), body: t('accHowToBody') },
              { key: 'returns', title: t('accReturnsTitle'), body: t('accReturnsBody') },
            ]}
          />
        </div>
      </section>

      <AboutArtistSection
        title={tPrintPdp('aboutArtistTitle')}
        name={artistContent.artist.name}
        bio={artistContent.artist.bio}
        image={PRINT_PDP_ARTIST_IMAGE}
      />
    </main>
  );
}
