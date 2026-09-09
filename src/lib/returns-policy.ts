import { EMAIL } from './email-addresses';
import { STUDIO } from './site';

export const RETURNS_POLICY = {
  email: EMAIL.contact,
  address: STUDIO.address,
  withdrawalDays: 14,
  returnDaysAfterNotice: 14,
  ordinaryReturnShipping: 'buyer',
  accountRequired: false,
  automatedLabels: false,
} as const;

export function returnContactHref(subject: string, orderId = ''): string {
  const reference = orderId.trim().slice(0,100);
  return `mailto:${RETURNS_POLICY.email}?subject=${encodeURIComponent(reference ? `${subject} — ${reference}` : subject)}`;
}
