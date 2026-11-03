export type OrderPaymentBreakdown = {
  total: number;
  currency: string;
  gift_card_amount: number;
  gift_card_balance_after?: number | null;
};

const LABELS = {
  pl: ['Wartość zamówienia', 'Z karty podarunkowej', 'Dopłata', 'Pozostałe saldo karty'],
  en: ['Order total', 'Gift card payment', 'Cash payment', 'Remaining gift card balance'],
  es: ['Total del pedido', 'Pago con tarjeta regalo', 'Pago adicional', 'Saldo restante de la tarjeta'],
  de: ['Bestellwert', 'Mit Geschenkkarte bezahlt', 'Zuzahlung', 'Restguthaben der Geschenkkarte'],
} as const;

/** Shared by customer/studio emails and order details; the card is payment,
 * never a discount from the value of the goods. */
export function paymentBreakdownRows(order: OrderPaymentBreakdown, locale: string) {
  const language = locale in LABELS ? locale as keyof typeof LABELS : 'pl';
  const labels = LABELS[language];
  const format = new Intl.NumberFormat(language, { style: 'currency', currency: order.currency.toUpperCase() });
  const amounts = [order.total, order.gift_card_amount, order.total - order.gift_card_amount];
  if (order.gift_card_balance_after != null) amounts.push(order.gift_card_balance_after);
  return amounts.map((amount, i) => ({ label: labels[i], value: format.format(amount / 100) }));
}
