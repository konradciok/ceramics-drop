import { setRequestLocale } from 'next-intl/server';

type Props = { params: Promise<{ locale: string }> };

/** Contact. Content: form (name/email/message) + studio details sidebar. */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <main>
      <section className="page-head">
        <div className="page-head-inner">
          <div className="eyebrow" />
          {/* TODO (content): title + lead */}
          <h1>Kontakt</h1>
        </div>
      </section>
      {/* TODO (content): <form className="contact-form"> + <aside className="contact-side"> */}
      <div className="contact-page" />
    </main>
  );
}
