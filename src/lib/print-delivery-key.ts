// Session-draft key for the print checkout address form. Lives in its own
// dependency-free module so pages that only clear the draft (koszyk/return)
// don't pull the zod + libphonenumber validation graph into their bundle.
export const PRINT_DELIVERY_DRAFT_KEY = 'acc_print_delivery_v1';
