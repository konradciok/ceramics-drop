/* Announcement bar — espresso strip above the header. Copy: content phase. */
import type { ReactNode } from 'react';

export function Announce({ children }: { children?: ReactNode }) {
  return (
    <div className="announce">
      <span className="dot" />
      {children}
      <span className="dot" />
    </div>
  );
}
