/** "$103.50" from integer cents (display only). */
export function formatUsd(minor: number): string {
  const dollars = Math.floor(minor / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${dollars}.${(minor % 100).toString().padStart(2, '0')}`;
}
