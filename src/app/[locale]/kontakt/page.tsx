import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { richTags } from '@/components/ui/richTags';
import { ContactForm } from '@/components/shop/ContactForm';
import { alternatesFor } from '@/lib/seo/urls';
import type { Locale } from '@/i18n/routing';
import { EMAIL } from '@/lib/email-addresses';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.kontakt'),
    description: t('meta.kontakt'),
    alternates: alternatesFor(locale as Locale, '/kontakt'),
  };
}

/** Contact page — form + studio details sidebar. */
export default async function KontaktPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale });

  return (
    <main>
      {/* ── PAGE HEAD ────────────────────────────────────────────── */}
      <section className="page-head">
        <div className="page-head-inner">
          <div className="eyebrow">{t('contact.eyebrow')}</div>
          <h1>{t.rich('contact.h1', richTags)}</h1>
          <p className="lead">{t('contact.lead')}</p>
        </div>
      </section>

      {/* ── CONTACT PAGE ─────────────────────────────────────────── */}
      <div className="contact-page">
        <ContactForm />

        <aside className="contact-side">
          <h3>{t('contact.sideH')}</h3>
          <div className="contact-list">
            <div className="contact-row">
              <span className="lbl">{t('contact.lEmail')}</span>
              <span className="val">
                <a href={`mailto:${EMAIL.contact}`}>{EMAIL.contact}</a>
              </span>
            </div>
            <div className="contact-row">
              <span className="lbl">{t('contact.lIg')}</span>
              <span className="val">{t('contact.vIg')}</span>
            </div>
            <div className="contact-row">
              <span className="lbl">{t('contact.lStudio')}</span>
              <span className="val">{t('contact.vStudio')}</span>
            </div>
            <div className="contact-row">
              <span className="lbl">{t('contact.lShip')}</span>
              <span className="val">{t('contact.vShip')}</span>
            </div>
            <div className="contact-row">
              <span className="lbl">{t('contact.lReply')}</span>
              <span className="val">{t('contact.vReply')}</span>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
