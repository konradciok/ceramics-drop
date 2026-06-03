import { Link } from '@/i18n/navigation';

export default function NotFound() {
  return (
    <main className="notfound">
      <div className="notfound-inner">
        <p className="notfound-code">404</p>
        <h1>Nie znaleziono strony</h1>
        <p className="notfound-body">
          Ta strona nie istnieje lub została przeniesiona.
        </p>
        <div className="notfound-actions">
          <Link href="/" className="btn btn-primary">Strona główna</Link>
          <Link href="/kubki" className="btn btn-ghost">Przejdź do sklepu</Link>
        </div>
      </div>
    </main>
  );
}
