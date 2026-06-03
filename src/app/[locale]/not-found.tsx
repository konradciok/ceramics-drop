import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

export default async function NotFound() {
  const t = await getTranslations('notFound');

  return (
    <main className="notfound">
      <div className="notfound-inner">
        <p className="notfound-code">404</p>
        <h1>{t('heading')}</h1>
        <p className="notfound-body">{t('body')}</p>
        <div className="notfound-actions">
          <Link href="/" className="btn btn-primary">{t('home')}</Link>
          <Link href="/kubki" className="btn btn-ghost">{t('shop')}</Link>
        </div>
      </div>
    </main>
  );
}
