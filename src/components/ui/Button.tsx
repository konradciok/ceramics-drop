/* Button — pill control. Primary (espresso→terracotta) or ghost. */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost';
  /** Append the brand arrow that nudges right on hover. */
  withArrow?: boolean;
  children?: ReactNode;
};

export function Button({
  variant = 'primary',
  withArrow = false,
  children,
  className = '',
  ...props
}: Props) {
  return (
    <button className={`btn btn-${variant} ${className}`.trim()} {...props}>
      {children}
      {withArrow && <Icon name="arrow" className="btn-arrow" />}
    </button>
  );
}
