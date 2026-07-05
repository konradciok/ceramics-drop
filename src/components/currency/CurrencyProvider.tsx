'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import {
  CURRENCY_COOKIE,
  CURRENCY_COOKIE_MAX_AGE,
  type Currency,
} from '@/lib/currency';

type CurrencyContextValue = {
  currency: Currency;
  /** Persist the choice to the cookie, update the client tree, and refresh
   *  server components (JSON-LD, cookie-derived prices) to match. */
  setCurrency: (next: Currency) => void;
};

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

/**
 * Seeds the client currency from the server-resolved value (which read the
 * `currency_pref` cookie) so SSR and hydration agree, then lets the header
 * switcher change it at runtime without a full navigation.
 */
export function CurrencyProvider({
  initial,
  children,
}: {
  initial: Currency;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [currency, setCurrencyState] = useState<Currency>(initial);

  const setCurrency = useCallback(
    (next: Currency) => {
      if (next === currency) return;
      document.cookie = `${CURRENCY_COOKIE}=${next}; path=/; max-age=${CURRENCY_COOKIE_MAX_AGE}; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`;
      setCurrencyState(next);
      // Re-render server components (structured data, any server-side prices)
      // now that the cookie changed; the client tree already re-rendered above.
      router.refresh();
    },
    [currency, router],
  );

  const value = useMemo<CurrencyContextValue>(
    () => ({ currency, setCurrency }),
    [currency, setCurrency],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

function useCurrencyContext(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error('useCurrency must be used within a CurrencyProvider');
  return ctx;
}

/** The active display currency for the current request. */
export function useCurrency(): Currency {
  return useCurrencyContext().currency;
}

/** Currency plus the setter, for the switcher control. */
export function useCurrencyControls(): CurrencyContextValue {
  return useCurrencyContext();
}
