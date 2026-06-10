/** Format a PLN amount the brand way: amount then unit — "90 zł". */
export const pln = (n: number): string => `${n} zł`;

/** Format a EUR amount: amount then unit — "22 €". */
export const eur = (n: number): string => `${n} €`;
