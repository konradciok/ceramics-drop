import { getTranslations } from 'next-intl/server';

// Text chips until licensed brand SVGs are sourced — each <li> then swaps its
// text node for a monochrome currentColor <svg> with no CSS changes.
const METHODS = ['Visa', 'Mastercard', 'BLIK', 'Przelewy24', 'Apple Pay', 'Google Pay'];

export async function PaymentBadges() {
  const t = await getTranslations();
  return (
    <ul className="footer-pay" aria-label={t('footer.payAria')}>
      {METHODS.map((method) => (
        <li key={method} className="chip">
          {method}
        </li>
      ))}
    </ul>
  );
}
