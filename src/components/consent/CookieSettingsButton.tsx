'use client';
import type { ReactNode } from 'react';
import { openConsentSettings } from './consent-mode';

/**
 * Reopens the consent banner so a visitor can change or withdraw their choice
 * (GDPR Art. 7(3): withdrawing must be as easy as giving). Rendered in the
 * footer's always-visible bottom row and in the privacy policy's cookies
 * section. A button, not a link: it opens UI in place and has no URL.
 */
export function CookieSettingsButton({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <button type="button" className={className} aria-haspopup="dialog" onClick={openConsentSettings}>
      {children}
    </button>
  );
}
