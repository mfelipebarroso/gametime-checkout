import { formatUsd } from './format';
import type { Attempt } from '../../shared/index';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Simulated Affirm page (D-10). The buttons POST; the server answers with a 302 back to the app. */
export function renderAffirmPage(attempt: Attempt): string {
  const id = escapeHtml(attempt.attemptId);
  const amount = escapeHtml(formatUsd(attempt.amount.minorUnits));
  const actionable = attempt.status === 'awaiting_user';
  const body = actionable
    ? `<p class="amount">${amount}</p>
       <p class="muted">Pay over time with Affirm (mock). No real credit check.</p>
       <form method="post" action="/mock/affirm/checkout/${id}/approve"><button class="primary" type="submit">Approve</button></form>
       <form method="post" action="/mock/affirm/checkout/${id}/cancel"><button class="secondary" type="submit">Cancel</button></form>`
    : `<p class="amount">${amount}</p><p class="muted">This checkout is ${escapeHtml(attempt.status)}. You can return to the app.</p>
       <a class="primary link" href="gametime-demo://payment/return?attemptId=${id}">Return to Gametime</a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Affirm (mock)</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 32px 20px; background: #f6f5ff; color: #101820; }
  .card { max-width: 420px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 28px 20px; box-shadow: 0 4px 20px rgba(0,0,0,.06); }
  h1 { color: #4a4af4; font-size: 28px; margin: 0 0 4px; }
  .amount { font-size: 34px; font-weight: 700; margin: 16px 0 4px; }
  .muted { color: #5b6470; margin: 0 0 24px; }
  form { margin: 0 0 12px; }
  button, .link { display: block; width: 100%; box-sizing: border-box; padding: 16px; border-radius: 999px; font-size: 17px; font-weight: 600; border: 0; text-align: center; text-decoration: none; }
  .primary { background: #4a4af4; color: #fff; }
  .secondary { background: #eef0f3; color: #101820; }
</style></head>
<body><div class="card"><h1>affirm</h1><p class="muted">Gametime · mock checkout</p>${body}</div></body></html>`;
}
