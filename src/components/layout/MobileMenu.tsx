'use client';

import { useEffect, useRef, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { LangSwitch } from './LangSwitch';

type NavLink = { href: string; label: string };

type Props = {
  links: NavLink[];
  aria: { open: string; close: string; nav: string };
};

export function MobileMenu({ links, aria }: Props) {
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab' || !drawerRef.current) return;
      // Focus trap
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const els = Array.from(focusable);
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);

    // Focus first interactive element in the drawer
    requestAnimationFrame(() => {
      drawerRef.current?.querySelector<HTMLElement>('button, a')?.focus();
    });

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  function close() {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="mob-trigger icon-btn"
        aria-label={aria.open}
        aria-expanded={open}
        aria-controls="mob-drawer"
        onClick={() => setOpen(true)}
      >
        <span className="mob-bar" />
        <span className="mob-bar" />
        <span className="mob-bar" />
      </button>

      {/* Overlay: aria-hidden only when closed so it's not a phantom element for AT */}
      <div
        className={`mob-overlay${open ? ' open' : ''}`}
        aria-hidden={!open}
        onClick={close}
      />

      {/* Drawer: inert when closed keeps focus out; focus trap above keeps focus in when open */}
      <div
        id="mob-drawer"
        ref={drawerRef}
        className={`mob-drawer${open ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={aria.nav}
        inert={!open}
      >
        <div className="mob-drawer-head">
          <button
            className="mob-close icon-btn"
            onClick={close}
            aria-label={aria.close}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width={19} height={19}>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <nav className="mob-nav" aria-label={aria.nav}>
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="mob-link"
              onClick={close}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="mob-lang">
          <LangSwitch />
        </div>
      </div>
    </>
  );
}
