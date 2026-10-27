import { formatUsd, type Money } from '@shared';

export function formatMoney(money: Money): string {
  return formatUsd(money.minorUnits);
}
