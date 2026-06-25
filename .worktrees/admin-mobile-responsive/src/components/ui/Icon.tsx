/* ============================================================
   Icon — thin stroked line icons (Lucide/Feather feel).
   Ported from design/assets/shop.js. They inherit `currentColor`
   and stroke width from CSS.
   ============================================================ */
import type { SVGProps } from 'react';

export type IconName =
  | 'cart'
  | 'check'
  | 'arrow'
  | 'close'
  | 'chevron-left'
  | 'chevron-right'
  | 'trash';

const PATHS: Record<IconName, React.ReactNode> = {
  cart: (
    <>
      <circle cx="9" cy="20" r="1.3" />
      <circle cx="18" cy="20" r="1.3" />
      <path d="M2 3h3l2.4 12.3a1.6 1.6 0 0 0 1.6 1.3h8.6a1.6 1.6 0 0 0 1.6-1.3L22 7H6" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 6.5" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  'chevron-left': <path d="M15 5l-7 7 7 7" />,
  'chevron-right': <path d="M9 5l7 7-7 7" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
};

type Props = SVGProps<SVGSVGElement> & { name: IconName };

export function Icon({ name, ...props }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {PATHS[name]}
    </svg>
  );
}
