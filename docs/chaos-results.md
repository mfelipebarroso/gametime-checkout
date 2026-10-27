# Chaos and interruption results

Run on 2026-10-26 on the Android emulator (`Pixel_RN`, API 36, `google_apis`, debug build with Metro),
driven by `adb` (taps located through `uiautomator`, `am force-stop`, relaunch) against the local mock
server. "Auth" is `SELECT count(*) FROM authorizations a JOIN payment_attempts p ON p.id=a.attempt_id
WHERE p.order_id='order_demo'` after the scenario. The demo was reset before each scenario.

| # | Scenario | What happened | Final attempt | Auth |
|---|---|---|---|---|
| M9 | Lost response (`drop_response`), card | Server committed the approval and destroyed the socket. Android's HTTP stack (OkHttp) silently retried the POST with the **same** `Idempotency-Key`; the server replayed the stored result instead of authorizing again. UI showed success. | `succeeded` | 1 |
| M10 | 8 s server latency, card, app killed while "Processing your payment…" | Killed with the attempt `processing`. Relaunch showed "We're checking your payment status. Don't pay again.", polled `GET` (no new authorize), then "You're in!". | `succeeded` | 1 |
| M11 | Google Pay sheet open (simulator: Google Pay "Set up"), app killed | Relaunch: "Your payment wasn't completed. You haven't been charged." The client cancelled the never-authorized attempt. | `cancelled` | 0 |
| M12 | Affirm, Approve in Chrome, return via `gametime-demo://` | Deep link logged as `deeplink_received` (`result=approved`, not trusted) → reconcile by `GET` → success. | `succeeded` | 1 |
| M13 | Affirm, app force-stopped, Approve in Chrome | The deep link cold-started the app, which reconciled from the persisted snapshot and showed success. | `succeeded` | 1 |
| M14 | Affirm, back to the app without approving, quantity 2 → 1 | App offered "Continue with Affirm / Choose another method". Changing quantity moved the total to $51.75, Affirm disappeared and the server cancelled the attempt. | `cancelled` (`QUOTE_STALE`) | 0 |

No duplicate charge and no invented success or decline in any scenario.

## Security sweep

- `grep -rnE "4242424242424242|tok_test" app/src server/src`: only the fake token generators/validators
  (the stubbed SDK) match; none of them log.
- Server request log (whole session) and app logcat `[checkout]` lines: 0 occurrences of the PAN,
  `tok_test` or `sourceToken`.
- App storage on the emulator (`databases/AsyncStorage` and its WAL): only `checkout.attempt.v1`
  snapshots with the allowlisted fields; 0 occurrences of the PAN, expiry or tokens.
- SQLite: `authorizations.source_token_kind` holds only kinds (`card_visa`, `google_pay`, `affirm`…);
  no stored response contains a token.

## Found and fixed during the run

- The server sent ETags, so Android issued conditional GETs and received `304`s while polling. Payment
  status must never come from an HTTP cache: ETags are now disabled and `/v1` responses carry
  `Cache-Control: no-store` (server test added).

## Not run

- M9–M14 were not repeated on the iOS simulator; the same orchestrator paths are covered by the
  automated orchestrator tests (`app/__tests__/orchestrator.test.ts`).
