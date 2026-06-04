-- Buyer locale for localised shipping-confirmation email, and a once-only
-- guard that prevents double-sending if the InPost webhook is redelivered.
-- Additive + nullable so existing rows stay valid (matching 0002/0003/0004 style).

alter table orders
  add column if not exists locale              text,        -- buyer's checkout locale ('pl' | 'en' | 'es'); drives the shipping-confirmation email language
  add column if not exists customer_notified_at timestamptz; -- once-only guard: set when the customer shipping-confirmation email is sent
