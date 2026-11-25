import type { DeliveryMethod } from '@/lib/pricing';
import type { DestinationCountry } from '@/lib/delivery/destinations';

/**
 * Client-side validation of the cart's delivery form. It drives the inline
 * field errors and the focus-first-error behaviour: the pay button stays
 * enabled, and a submit with anything missing shows what is wrong instead of
 * leaving the buyer in front of a greyed-out button.
 *
 * The server (validateDelivery in src/lib/delivery/validate.ts) stays the
 * authority. These rules only add format checks that catch obvious typos
 * before a request is made — the phone carries the parcel's pickup code.
 */

/** The fields in on-screen order — the first invalid one gets focus. */
export const DELIVERY_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'point',
  'street',
  'building',
  'postCode',
  'city',
] as const;

export type DeliveryField = (typeof DELIVERY_FIELDS)[number];

/** i18n key suffix under `delivery.errors`. */
export type DeliveryFieldError = 'required' | 'email' | 'phone' | 'point';

export type DeliveryFieldErrors = Partial<Record<DeliveryField, DeliveryFieldError>>;

export type DeliveryFormInput = {
  method: DeliveryMethod;
  contact: { firstName: string; lastName: string; email: string; phone: string };
  address: { street: string; building: string; postCode: string; city: string };
  /** Whether a pickup point usable for the current destination is chosen. */
  pointChosen: boolean;
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Only phone characters, and 7–15 digits (E.164 allows at most 15). */
export function isPlausiblePhone(raw: string): boolean {
  const value = raw.trim();
  if (!/^[+\d\s().-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
}

export function validateDeliveryForm({ method, contact, address, pointChosen }: DeliveryFormInput): DeliveryFieldErrors {
  const errors: DeliveryFieldErrors = {};
  const blank = (v: string) => v.trim() === '';

  if (blank(contact.firstName)) errors.firstName = 'required';
  if (blank(contact.lastName)) errors.lastName = 'required';
  if (blank(contact.email)) errors.email = 'required';
  else if (!EMAIL_RE.test(contact.email.trim())) errors.email = 'email';
  // Studio pickup needs no phone; every carrier method sends the pickup code to it.
  if (method !== 'odbior' && !isPlausiblePhone(contact.phone)) errors.phone = 'phone';

  if (method === 'paczkomat' && !pointChosen) errors.point = 'point';

  if (method === 'kurier') {
    if (blank(address.street)) errors.street = 'required';
    if (blank(address.building)) errors.building = 'required';
    if (blank(address.postCode)) errors.postCode = 'required';
    if (blank(address.city)) errors.city = 'required';
  }
  return errors;
}

/** The invalid fields, in on-screen order. */
export function invalidDeliveryFields(errors: DeliveryFieldErrors): DeliveryField[] {
  return DELIVERY_FIELDS.filter((field) => errors[field] !== undefined);
}

/** International dialling codes of the delivery countries (for the phone hint). */
const CALLING_CODES: Record<DestinationCountry, string> = {
  ES: '34', PT: '351', FR: '33', DE: '49', AT: '43', BE: '32', NL: '31', LU: '352', IT: '39', PL: '48',
};

/**
 * The phone field's placeholder: a national example for Poland, the country's
 * dialling code elsewhere — a buyer abroad otherwise tends to leave it out.
 */
export function phonePlaceholder(country: DestinationCountry): string {
  return country === 'PL' ? '600 100 200' : `+${CALLING_CODES[country]} …`;
}

/** Mail domains common among the shop's buyers (PL, ES, DE and international). */
const COMMON_EMAIL_DOMAINS = [
  'gmail.com', 'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl', 'op.pl', 'poczta.fm', 'tlen.pl', 'vp.pl',
  'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'protonmail.com',
  'hotmail.es', 'yahoo.es', 'gmx.de', 'web.de', 't-online.de', 'gmx.net',
] as const;

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = current;
    }
  }
  return row[b.length];
}

/**
 * The address with its domain corrected when that domain is a near miss of a
 * common one ("anna@gmial.com" → "anna@gmail.com"), else null. Only a hint the
 * buyer can accept — never applied on its own. Short domains need a single
 * edit, so a real small domain is not "corrected" into a big one.
 */
export function suggestEmailDomain(email: string): string | null {
  const match = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(email.trim());
  if (!match) return null;
  const [, local, rawDomain] = match;
  const domain = rawDomain.toLowerCase();
  if ((COMMON_EMAIL_DOMAINS as readonly string[]).includes(domain)) return null;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of COMMON_EMAIL_DOMAINS) {
    const distance = editDistance(domain, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const allowed = domain.length <= 6 ? 1 : 2;
  return best && bestDistance <= allowed ? `${local}@${best}` : null;
}
