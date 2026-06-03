'use client';

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function Error({ reset }: Props) {
  return (
    <main className="error-page">
      <div className="error-page-inner">
        <div className="error-seal">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </div>
        <h1>Coś poszło nie tak</h1>
        <p>Wystąpił nieoczekiwany błąd. Spróbuj odświeżyć stronę.</p>
        <button className="btn btn-primary" onClick={reset}>
          Spróbuj ponownie
        </button>
      </div>
    </main>
  );
}
