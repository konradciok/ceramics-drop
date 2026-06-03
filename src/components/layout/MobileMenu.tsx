'use client';

import { useEffect, useRef, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { LangSwitch } from './LangSwitch';

type NavLink = { href: string; label: string };

type Props = {
  links: NavLink[];
};

export function MobileMenu({ links }: Props) {
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    // Focus first link in drawer
    const firstLink = drawerRef.current?.querySelector<HTMLElement>('a, button:not(.mob-close)');
    firstLink?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="mob-trigger icon-btn"
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-controls="mob-drawer"
        onClick={() => setOpen(true)}
      >
        <span className="mob-bar" />
        <span className="mob-bar" />
        <span className="mob-bar" />
      </button>

      {/* Overlay */}
      <div
        className={`mob-overlay${open ? ' open' : ''}`}
        aria-hidden="true"
        onClick={close}
      />

      {/* Drawer */}
      <div
        id="mob-drawer"
        ref={drawerRef}
        className={`mob-drawer${open ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        // inert when closed prevents focus from entering (React 19 boolean attribute)
        inert={!open}
      >
        <div className="mob-drawer-head">
          <button
            className="mob-close icon-btn"
            onClick={close}
            aria-label="Close navigation menu"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width={19} height={19}>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <nav className="mob-nav" aria-label="Main navigation">
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
