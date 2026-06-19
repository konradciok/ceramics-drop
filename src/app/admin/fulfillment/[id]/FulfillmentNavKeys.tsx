'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

type Props = {
  prevHref: string | null;
  nextHref: string | null;
};

export function FulfillmentNavKeys({ prevHref, nextHref }: Props) {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key === 'ArrowLeft' && prevHref) {
        event.preventDefault();
        router.push(prevHref);
      }
      if (event.key === 'ArrowRight' && nextHref) {
        event.preventDefault();
        router.push(nextHref);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nextHref, prevHref, router]);

  return null;
}
