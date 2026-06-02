import { setRequestLocale } from 'next-intl/server';

type Props = { params: Promise<{ locale: string }> };

/** Studio / about. Content: hero, tools & materials, pull-quote, CTA. */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <main>
      <section className="page-head">
        <div className="page-head-inner">
          <div className="eyebrow" />
          {/* TODO (content): title + lead */}
          <h1>O studiu</h1>
        </div>
      </section>
    </main>
  );
}
