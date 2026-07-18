import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';
import { PRINT_COUNTRIES, type PrintCountry } from './print-shipping';

export type PrintShippingAddress = {
  line1: string;
  line2?: string;
  city: string;
  post_code: string;
  country_code: PrintCountry;
};

export type PrintDeliveryContact = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
};

export type PrintDeliverySelection = {
  method: 'kurier';
  contact: PrintDeliveryContact;
  address: PrintShippingAddress;
};

export { PRINT_DELIVERY_DRAFT_KEY } from './print-delivery-key';

const requiredText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().max(max).optional(),
  );

export const printShippingAddressSchema = z.object({
  line1: requiredText(120),
  line2: optionalText(120),
  city: requiredText(120),
  post_code: requiredText(20),
  country_code: z.enum(PRINT_COUNTRIES),
});

export function printDeliveryContactSchema(country: PrintCountry) {
  return z.object({
    first_name: requiredText(100),
    last_name: requiredText(100),
    email: z.string().trim().max(254).email().transform((value) => value.toLowerCase()),
    phone: z.string().trim().min(1).max(50).transform((value, ctx) => {
      const phone = parsePhoneNumberFromString(value, country);
      if (!phone?.isValid()) {
        ctx.addIssue({ code: 'custom', message: 'invalid_phone' });
        return z.NEVER;
      }
      return phone.number;
    }),
  });
}

export type ValidatePrintDeliveryResult =
  | { ok: true; delivery: PrintDeliverySelection }
  | { ok: false; reason: 'invalid_delivery' | 'invalid_contact' | 'invalid_address' };

/** Validate and normalize the print-only checkout payload before any pricing or payment work. */
export function validatePrintDelivery(raw: unknown): ValidatePrintDeliveryResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'invalid_delivery' };
  }
  const body = raw as Record<string, unknown>;
  if (body.delivery_method !== 'kurier') {
    return { ok: false, reason: 'invalid_delivery' };
  }

  const address = printShippingAddressSchema.safeParse(body.address);
  if (!address.success) return { ok: false, reason: 'invalid_address' };

  const contact = printDeliveryContactSchema(address.data.country_code).safeParse(body.contact);
  if (!contact.success) return { ok: false, reason: 'invalid_contact' };

  return {
    ok: true,
    delivery: { method: 'kurier', contact: contact.data, address: address.data },
  };
}
