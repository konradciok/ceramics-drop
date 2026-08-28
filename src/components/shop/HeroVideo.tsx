'use client';

import { useEffect, useState } from 'react';

/** A resolved hero video slot: the video URL plus its poster (already used as
    the server-rendered `<picture>` fallback, so this component never causes
    a visible flash while it decides which breakpoint's video to mount). */
export type HeroVideoSlot = {
  src: string;
  poster: { src: string; width: number; height: number };
};

type Props = {
  desktop?: HeroVideoSlot;
  mobile?: HeroVideoSlot;
};

/**
 * Mounts at most one `<video>` — the active breakpoint's, chosen by
 * `matchMedia`, and only when the visitor hasn't asked for reduced motion.
 * Never render both breakpoints' videos and toggle with CSS: a CSS-hidden
 * `<video>` still downloads.
 *
 * Renders null on the server and on first client render (safe default that
 * matches across hydration), then resolves after mount.
 */
export function HeroVideo({ desktop, mobile }: Props) {
  const [active, setActive] = useState<HeroVideoSlot | undefined>(undefined);

  useEffect(() => {
    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const desktopQuery = window.matchMedia('(min-width:861px)');

    const update = () => {
      if (reduceQuery.matches) {
        setActive(undefined);
        return;
      }
      setActive(desktopQuery.matches ? desktop : mobile);
    };
    update();

    reduceQuery.addEventListener('change', update);
    desktopQuery.addEventListener('change', update);
    return () => {
      reduceQuery.removeEventListener('change', update);
      desktopQuery.removeEventListener('change', update);
    };
  }, [desktop, mobile]);

  if (!active) return null;

  return (
    <video
      className="hero-video"
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      poster={active.poster.src}
      src={active.src}
    />
  );
}
