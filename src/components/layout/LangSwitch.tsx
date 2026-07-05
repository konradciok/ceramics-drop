'use client';

import { useLocale } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';

/** PL · EN · ES · DE pill switcher (locales from `routing.locales`; no GB).
 *  Swaps locale while keeping the path. */
export function LangSwitch() {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="lang-switch" role="group" aria-label="Język">
      {routing.locales.map((l) => (
        <button
          key={l}
          type="button"
          className={l === locale ? 'active' : undefined}
          aria-current={l === locale ? 'true' : undefined}
          onClick={() => {
            if (l !== locale) {
              pushDataLayer(
                buildEngagementEvent('language_change', {
                  from_locale: locale,
                  to_locale: l,
                  page_path: pathname,
                }),
              );
            }
            router.replace(pathname, { locale: l });
          }}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
