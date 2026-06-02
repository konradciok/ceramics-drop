import { setRequestLocale } from 'next-intl/server';

type Props = { params: Promise<{ locale: string }> };

/**
 * Home. Content phase: hero, marquee, collections grid, studio story,
 * "how it works", contact — see design/index.html.
 */
export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <main>
      {/* scaffold placeholder */}
      <section className="section">
        <div className="section-inner">
          <div className="section-eyebrow">Home</div>
        </div>
      </section>
    </main>
  );
}
