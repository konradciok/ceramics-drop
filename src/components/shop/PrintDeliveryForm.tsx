'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  PRINT_DELIVERY_DRAFT_KEY,
  printDeliveryContactSchema,
  printShippingAddressSchema,
  type PrintDeliveryContact,
  type PrintShippingAddress,
} from '@/lib/print-delivery';
import { isPrintCountry, type PrintCountry } from '@/lib/print-shipping';
import { AddressAutocomplete } from './AddressAutocomplete';
import type { ParsedPlaceAddress } from '@/lib/google-places';

export const PRINT_DELIVERY_FORM_ID = 'print-delivery-form';

type Draft = {
  contact: Record<keyof PrintDeliveryContact, string>;
  address: Omit<Record<keyof PrintShippingAddress, string>, 'country_code'> & { country_code: PrintCountry };
};

type FieldName =
  | 'first_name' | 'last_name' | 'email' | 'phone'
  | 'country_code' | 'line1' | 'line2' | 'post_code' | 'city';

const EMPTY_DRAFT = (country: PrintCountry): Draft => ({
  contact: { first_name: '', last_name: '', email: '', phone: '' },
  address: { country_code: country, line1: '', line2: '', post_code: '', city: '' },
});

function readDraft(fallbackCountry: PrintCountry): Draft {
  if (typeof window === 'undefined') return EMPTY_DRAFT(fallbackCountry);
  try {
    const raw = JSON.parse(sessionStorage.getItem(PRINT_DELIVERY_DRAFT_KEY) ?? 'null') as Partial<Draft> | null;
    if (!raw?.contact || !raw.address) return EMPTY_DRAFT(fallbackCountry);
    const country = raw.address.country_code;
    const supportedCountry = typeof country === 'string'
      && printShippingAddressSchema.shape.country_code.safeParse(country).success
      ? country as PrintCountry
      : fallbackCountry;
    return {
      contact: {
        first_name: raw.contact.first_name ?? '',
        last_name: raw.contact.last_name ?? '',
        email: raw.contact.email ?? '',
        phone: raw.contact.phone ?? '',
      },
      address: {
        country_code: supportedCountry,
        line1: raw.address.line1 ?? '',
        line2: raw.address.line2 ?? '',
        post_code: raw.address.post_code ?? '',
        city: raw.address.city ?? '',
      },
    };
  } catch {
    return EMPTY_DRAFT(fallbackCountry);
  }
}

function errorKey(issue: { code: string; message: string }): 'required' | 'email' | 'phone' | 'tooLong' | 'invalid' {
  if (issue.message === 'invalid_phone') return 'phone';
  if (issue.code === 'invalid_format') return 'email';
  if (issue.code === 'too_big') return 'tooLong';
  if (issue.code === 'too_small') return 'required';
  return 'invalid';
}

export function PrintDeliveryForm({
  initialCountry,
  countryOptions,
  onCountryChange,
  onSubmit,
}: {
  initialCountry: PrintCountry;
  countryOptions: Array<{ code: PrintCountry; name: string }>;
  onCountryChange: (country: PrintCountry) => void;
  onSubmit: (delivery: { contact: PrintDeliveryContact; address: PrintShippingAddress }) => void | Promise<void>;
}) {
  const t = useTranslations('delivery');
  const [draft, setDraft] = useState<Draft>(() => readDraft(initialCountry));
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const formRef = useRef<HTMLFormElement>(null);
  // Fields to re-validate once an autocomplete-driven `draft` update commits
  // (see `handleSelectPlace`) — kept out of the `setDraft` updater itself so
  // the updater stays pure (React may invoke it more than once).
  const pendingPlaceValidationRef = useRef<FieldName[] | null>(null);

  useEffect(() => {
    sessionStorage.setItem(PRINT_DELIVERY_DRAFT_KEY, JSON.stringify(draft));
    onCountryChange(draft.address.country_code);
  }, [draft, onCountryChange]);

  useEffect(() => {
    const fields = pendingPlaceValidationRef.current;
    if (!fields) return;
    pendingPlaceValidationRef.current = null;
    fields.forEach((field) => validateField(field));
    // `validateField` reads the committed `draft` via its default snapshot
    // param, and this effect only runs after `draft` commits, so it never
    // sees a stale value — this is why the flag+effect indirection exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // `snapshot` defaults to the current `draft` closure, but callers that
  // just wrote fresh state via `setDraft` (e.g. autocomplete selection) can
  // pass the just-computed draft so validation doesn't run against stale data.
  function parsed(snapshot: Draft = draft) {
    return {
      contact: printDeliveryContactSchema(snapshot.address.country_code).safeParse(snapshot.contact),
      address: printShippingAddressSchema.safeParse(snapshot.address),
    };
  }

  function collectErrors(only?: FieldName, snapshot: Draft = draft): Partial<Record<FieldName, string>> {
    const next: Partial<Record<FieldName, string>> = {};
    const result = parsed(snapshot);
    for (const parseResult of [result.contact, result.address]) {
      if (parseResult.success) continue;
      for (const issue of parseResult.error.issues) {
        const field = issue.path[0] as FieldName;
        if ((!only || field === only) && next[field] === undefined) {
          next[field] = t(`errors.${errorKey(issue)}`);
        }
      }
    }
    return next;
  }

  function validateField(field: FieldName, snapshot: Draft = draft) {
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return { ...next, ...collectErrors(field, snapshot) };
    });
  }

  // Selecting an autocomplete suggestion (KTD: AddressAutocomplete is
  // controlled — it hands us the parsed place, we own draft/errors). The
  // `setDraft` updater reads its own `d` (not the outer `draft` closure) so
  // a field edited while the async place-details fetch was in flight isn't
  // silently reverted by a stale merge — and, since React may invoke an
  // updater more than once, it stays a pure computation with no side
  // effects of its own; the pending-validation flag + effect above run the
  // validation once the update has actually committed.
  function handleSelectPlace(parsedAddress: ParsedPlaceAddress) {
    setDraft((d) => ({
      ...d,
      address: {
        ...d.address,
        line1: parsedAddress.line1 || d.address.line1,
        city: parsedAddress.city || d.address.city,
        post_code: parsedAddress.post_code || d.address.post_code,
        country_code: isPrintCountry(parsedAddress.country_code)
          ? parsedAddress.country_code
          : d.address.country_code,
      },
    }));
    pendingPlaceValidationRef.current = ['line1', 'city', 'post_code', 'country_code'];
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = parsed();
    if (!result.contact.success || !result.address.success) {
      const next = collectErrors();
      setErrors(next);
      requestAnimationFrame(() => {
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }
    setErrors({});
    await onSubmit({ contact: result.contact.data, address: result.address.data });
  }

  const fieldError = (field: FieldName) => errors[field]
    ? <span className="field-error" role="alert" id={`print-${field}-error`}>{errors[field]}</span>
    : null;
  const aria = (field: FieldName) => ({
    'aria-invalid': errors[field] ? true as const : undefined,
    'aria-describedby': errors[field] ? `print-${field}-error` : undefined,
  });

  return (
    <form id={PRINT_DELIVERY_FORM_ID} ref={formRef} className="delivery-fields" onSubmit={submit} noValidate>
      <div className="field-row">
        <label className="field">
          <span>{t('firstName')}</span>
          <input name="contact.first_name" required autoComplete="section-print shipping given-name"
            value={draft.contact.first_name} onChange={(e) => setDraft((d) => ({ ...d, contact: { ...d.contact, first_name: e.target.value } }))}
            onBlur={() => validateField('first_name')} {...aria('first_name')} />
          {fieldError('first_name')}
        </label>
        <label className="field">
          <span>{t('lastName')}</span>
          <input name="contact.last_name" required autoComplete="section-print shipping family-name"
            value={draft.contact.last_name} onChange={(e) => setDraft((d) => ({ ...d, contact: { ...d.contact, last_name: e.target.value } }))}
            onBlur={() => validateField('last_name')} {...aria('last_name')} />
          {fieldError('last_name')}
        </label>
      </div>
      <label className="field">
        <span>{t('email')}</span>
        <input name="contact.email" type="email" inputMode="email" required autoComplete="section-print shipping email"
          value={draft.contact.email} onChange={(e) => setDraft((d) => ({ ...d, contact: { ...d.contact, email: e.target.value } }))}
          onBlur={() => validateField('email')} {...aria('email')} />
        {fieldError('email')}
      </label>
      <label className="field">
        <span>{t('phone')}</span>
        <input name="contact.phone" type="tel" inputMode="tel" required autoComplete="section-print shipping tel"
          value={draft.contact.phone} onChange={(e) => setDraft((d) => ({ ...d, contact: { ...d.contact, phone: e.target.value } }))}
          onBlur={() => validateField('phone')} {...aria('phone')} />
        {fieldError('phone')}
      </label>
      <label className="field">
        <span>{t('country')}</span>
        <select name="address.country_code" required autoComplete="section-print shipping country" data-testid="country-select"
          value={draft.address.country_code}
          onChange={(e) => {
            const country_code = e.target.value as PrintCountry;
            setDraft((d) => ({ ...d, address: { ...d.address, country_code } }));
            setErrors((current) => ({ ...current, phone: undefined, country_code: undefined }));
          }}
          onBlur={() => validateField('country_code')} {...aria('country_code')}>
          {countryOptions.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
        </select>
        {fieldError('country_code')}
      </label>
      <label className="field">
        <span>{t('line1')}</span>
        <AddressAutocomplete name="address.line1" required autoComplete="section-print shipping address-line1"
          value={draft.address.line1} onChange={(line1) => setDraft((d) => ({ ...d, address: { ...d.address, line1 } }))}
          onSelectPlace={handleSelectPlace} countryCode={draft.address.country_code}
          suggestionsLabel={t('suggestionsLabel')} attributionLabel={t('googleAttribution')}
          onBlur={() => validateField('line1')} {...aria('line1')} />
        {fieldError('line1')}
      </label>
      <label className="field">
        <span>{t('line2')}</span>
        <input name="address.line2" autoComplete="section-print shipping address-line2"
          value={draft.address.line2} onChange={(e) => setDraft((d) => ({ ...d, address: { ...d.address, line2: e.target.value } }))}
          onBlur={() => validateField('line2')} {...aria('line2')} />
        {fieldError('line2')}
      </label>
      <div className="field-row">
        <label className="field">
          <span>{t('postCode')}</span>
          <input name="address.post_code" inputMode="text" required autoComplete="section-print shipping postal-code"
            value={draft.address.post_code} onChange={(e) => setDraft((d) => ({ ...d, address: { ...d.address, post_code: e.target.value } }))}
            onBlur={() => validateField('post_code')} {...aria('post_code')} />
          {fieldError('post_code')}
        </label>
        <label className="field">
          <span>{t('city')}</span>
          <input name="address.city" required autoComplete="section-print shipping address-level2"
            value={draft.address.city} onChange={(e) => setDraft((d) => ({ ...d, address: { ...d.address, city: e.target.value } }))}
            onBlur={() => validateField('city')} {...aria('city')} />
          {fieldError('city')}
        </label>
      </div>
    </form>
  );
}
