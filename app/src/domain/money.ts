import type { Money } from '@shared';

/**
 * Formats integer cents as dollars: 10350 → "$103.50".
 * Display only; never do math with the result (invariant 9).
 */
export function formatUSD(minor: number): string {
  if (!Number.isInteger(minor)) {
    throw new Error('formatUSD expects integer minor units');
  }
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (abs % 100).toString().padStart(2, '0');
  return `${sign}$${dollars}.${cents}`;
}

export function formatMoney(money: Money): string {
  return formatUSD(money.minorUnits);
}
