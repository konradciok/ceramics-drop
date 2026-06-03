'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { loadStripe } from '@stripe/stripe-js';
import { useCart } from '@/store/cart';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';
import { resolveCartProducts } from '@/lib/products';
import { SHIPPING_PLN } from '@/lib/pricing';
import { buildPurchaseEvent, pushDataLayer } from '@/lib/analytics';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);
type Status = 'loading' | 'ok' | 'processing' | 'fail';

export default function ReturnPage() {
  const t = useTranslations('return');
  const clear = useCart((s) => s.clear);
  const [status, setStatus] = useState<Status>('loading');
  const firedRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const secret = params.get('payment_intent_client_secret');
    const piId = params.get('payment_intent');
    stripePromise.then(async (stripe) => {
      if (!secret || !stripe) { setStatus('fail'); return; }
      const { paymentIntent } = await stripe.retrievePaymentIntent(secret);
      switch (paymentIntent?.status) {
        case 'succeeded': {
          // Fire purchase analytics exactly once per payment_intent
          const guardKey = `acc_purchase_fired_${piId ?? secret}`;
          if (!firedRef.current && !sessionStorage.getItem(guardKey)) {
            firedRef.current = true;
            sessionStorage.setItem(guardKey, '1');
            const ids = useCart.getState().ids;
            const products = resolveCartProducts(ids);
            const methodRaw = sessionStorage.getItem('acc_ship');
            const method = methodRaw === 'odbior' ? 'odbior' : 'kurier';
            const shippingCost = method === 'odbior' ? 0 : SHIPPING_PLN;
            if (products.length > 0) {
              pushDataLayer(
                buildPurchaseEvent(products, {
                  orderNo: paymentIntent.id,
                  shippingCost,
                  shippingMethod: method,
                }),
              );
            }
          }
          clear();
          setStatus('ok');
          break;
        }
        case 'processing':
          setStatus('processing');
          break;
        default:
          setStatus('fail');
      }
    });
  }, [clear]);

  if (status === 'loading') return <main id="cart-root" />;
  const key = status === 'ok' ? 'ok' : status === 'processing' ? 'processing' : 'fail';
  return (
    <main id="cart-root">
      <div className="confirm">
        {status === 'ok' && <div className="seal"><Icon name="check" /></div>}
        <h1>{t.rich(`${key}H`, richTags)}</h1>
        <p>{t(`${key}P`)}</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link href="/" className="btn btn-primary">{t('back')} <Icon name="arrow" /></Link>
          <Link href="/koszyk" className="btn btn-ghost">{t('cart')}</Link>
        </div>
      </div>
    </main>
  );
}
