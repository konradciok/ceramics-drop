import { setRequestLocale } from 'next-intl/server';

type Props = { params: Promise<{ locale: string }> };

/** Shipping & returns — prose page (TOC + sections). Content phase. */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <main>
      <section className="page-head">
        <div className="page-head-inner">
          <div className="eyebrow" />
          <h1>Dostawa i zwroty</h1>
        </div>
      </section>
      {/* TODO (content): <div className="prose-wrap"> TOC + prose sections */}
      <div className="prose-wrap" />
    </main>
  );
}
