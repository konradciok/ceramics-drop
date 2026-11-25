import type { DeliveryMethod } from '@/lib/pricing';

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
