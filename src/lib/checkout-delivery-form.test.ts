import { describe, expect, it } from 'vitest';
import {
  invalidDeliveryFields,
  isPlausiblePhone,
  validateDeliveryForm,
  type DeliveryFormInput,
} from './checkout-delivery-form';

const filled: DeliveryFormInput = {
  method: 'paczkomat',
  contact: { firstName: 'Anna', lastName: 'Kowalska', email: 'anna@example.com', phone: '600 100 200' },
  address: { street: '', building: '', postCode: '', city: '' },
  pointChosen: true,
};

describe('validateDeliveryForm', () => {
  it('passes a complete locker order', () => {
    expect(validateDeliveryForm(filled)).toEqual({});
  });

  it('reports every empty locker field, in on-screen order', () => {
    const errors = validateDeliveryForm({
      ...filled,
      contact: { firstName: ' ', lastName: '', email: '', phone: '' },
      pointChosen: false,
    });
    expect(errors).toEqual({
      firstName: 'required',
      lastName: 'required',
      email: 'required',
      phone: 'phone',
      point: 'point',
    });
    expect(invalidDeliveryFields(errors)).toEqual(['firstName', 'lastName', 'email', 'phone', 'point']);
  });

  it('flags a malformed email separately from a missing one', () => {
    expect(validateDeliveryForm({ ...filled, contact: { ...filled.contact, email: 'anna@example' } })).toEqual({
      email: 'email',
    });
  });

  it('needs no phone and no point for studio pickup', () => {
    expect(
      validateDeliveryForm({ ...filled, method: 'odbior', contact: { ...filled.contact, phone: '' }, pointChosen: false }),
    ).toEqual({});
  });

  it('requires the full address for courier delivery, but no point', () => {
    const errors = validateDeliveryForm({ ...filled, method: 'kurier', pointChosen: false });
    expect(invalidDeliveryFields(errors)).toEqual(['street', 'building', 'postCode', 'city']);
  });
});

describe('isPlausiblePhone', () => {
  it.each(['600100200', '+48 600 100 200', '+34 612-345-678', '(030) 1234567', '1234567'])('accepts %s', (phone) => {
    expect(isPlausiblePhone(phone)).toBe(true);
  });

  it.each(['', '600', '123456', 'tel 600100200', '+48 600 100 200 300 400'])('rejects %j', (phone) => {
    expect(isPlausiblePhone(phone)).toBe(false);
  });
});
