# Design decisions

The calls I made while building this, and where the implementation moved away from `docs/SPEC.md`.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D-01 | **Bare React Native + TypeScript** (not Expo) | Direct access to Swift/Kotlin for PassKit and `isReadyToPay` |
| D-02 | **Scope is the take-home.** Production concerns go to "With more time" in the README | Time budget |
| D-03 | Server is **Node + Express + better-sqlite3**, with mock routes behind `MOCK_MODE=1` | A real HTTP boundary; SQLite gives `UNIQUE` constraints and transactions, synchronously |
| D-04 | **Jest** in the app (RN template default), **Vitest + Supertest** on the server | Each side uses its stack's usual runner |
| D-05 | Wallet detection is a **Turbo Module** (`WalletCapability`) | Current recommended architecture. Only PassKit and Play Services can tell whether a card is provisioned |
| D-06 | A decline returns **`200` with `status: declined`** | It is a definitive business result, not a transport error the client should retry |
| D-07 | An **unknown card brand is invalid** | Clear test matrix; the mock processor only knows four brands |
| D-08 | Demo order: $42.50 + $9.25 fee per ticket (qty 1 = $51.75, qty 2 = $103.50) | Changing the quantity crosses the Affirm threshold naturally |
| D-09 | **Affirm is a server-rendered HTML page** opened in the system browser, returning via `gametime-demo://` | Genuinely exercises backgrounding, cold start and deep links |
| D-10 | **Apple Pay and Google Pay sheets are JS modals** | No merchant ID or PSP; what matters is the express flow and the cancel path |
| D-11 | **Shared contract types** through Metro `watchFolders`, a Babel alias (`@shared`), tsconfig `paths` and Jest `moduleNameMapper` | One contract, no copy step |

## Data model

- **Two state models.** The server keeps a lean attempt status (`awaiting_user`, `processing`,
  `succeeded`, `declined`, `cancelled`); the client has its own UI state machine with an explicit
  mapping. "Reconciling" is a client state, not a server one.
- **Two idempotency keys per attempt:** `clientAttemptId` for create and `authorizeKey` for authorize,
  generated together and persisted before the first request. On top of that the server enforces one
  authorization per attempt (`UNIQUE(attempt_id)`) and one success per order (partial unique index).
- **The snapshot is saved before the first request**, not just before opening the wallet or browser.
  That also covers losing the create response.
- **Error bodies carry context:** `quote` comes with `QUOTE_STALE` and `attempt` with attempt
  conflicts, so the client can recover without an extra GET.
- **`POST /:id/cancel`** exists so a cancelled sheet or an abandoned attempt is recorded server-side.
- **`GET/PUT /v1/orders/:id`** exists so the server can reject a stale order version.

## Server

- **Create replay returns the attempt's current state**, not the stored 201. That is how the client
  recovers `attemptId` and status after losing the response. Only successful creates are stored, so a
  retry after an error is evaluated again.
- **The authorize hash includes the `attemptId`:** reusing a key on another attempt is
  `409 IDEMPOTENCY_KEY_REUSED`.
- **Mock latency is modeled as `processing` with a `resolve_at`.** The request waits for the result,
  and a GET in the meantime sees `processing`, so killing the app mid-authorize ends in success through
  polling, never in an ambiguous state. Once resolved, the stored response for the key is updated.
- **An order version change** (quantity PUT or mock total override) cancels the order's
  `awaiting_user` attempts with `failureCode: QUOTE_STALE`. Authorizing one of them is
  `409 QUOTE_STALE` (with `attempt` and `quote`).
- **Mock total override:** the quote shows `subtotal = override` and `fees = 0`. A quantity PUT clears
  it.
- **The Affirm approve path** reuses authorize with a fixed key, `affirm:<attemptId>`, stored under the
  `authorize` scope.
- **`sourceToken`** must match `^tok_test_[a-z0-9_]+$`, otherwise `422` (the value is never echoed).
- **No HTTP caching of payment state:** ETags are disabled and `/v1` sends `Cache-Control: no-store`.
  Polling GETs were coming back as `304`s before that.

## Client

- **The orchestrator owns the state** and exposes it as an external store (`subscribe`/`getView` for
  `useSyncExternalStore`) instead of a component `useReducer`. The double-tap guard and
  `START_PAYMENT` then run synchronously against the current state; a `useReducer` value read through a
  ref would lag a render behind.
- **The reducer is pure.** Invalid transitions return the same state and are reported through a
  callback, which logs `invalid_transition`.
- **`ready` can carry a notice** (`quote_changed`, `payment_not_completed`), and `reconciling.reason`
  includes `affirm_pending` ("Continue with Affirm") and `exhausted` ("Check again").
- **Quantity is locked during an attempt**, except while an Affirm attempt is pending. That attempt
  was never authorized, and the server cancels it when the version changes.
- **Reconciliation re-authorizes at most once per run** (same key, token still in memory). If the
  attempt is still `awaiting_user` after that, it is cancelled (atomic, only from `awaiting_user`) and
  the fan sees "Your payment wasn't completed." This avoids an authorize ↔ reconcile loop.
- **`409 ATTEMPT_IN_PROGRESS` on create:** the client follows the existing attempt by polling. It never
  authorizes it, since it has neither its key nor its token.
- **Server `cancelled`** shows a short "Payment cancelled." and then returns to `ready`. `cancelled`
  with `QUOTE_STALE` reloads the order and shows the total-changed notice instead.

## Card form

- **Pay stays disabled until the card is valid**, so errors show on blur only. The "show every error
  on submit" path only runs as a guard inside `onPress`.
- **An ambiguous number prefix** ("2", "6", "27") is `NUMBER_INCOMPLETE`, not `BRAND_UNSUPPORTED`,
  while it can still become a supported brand.
- **`complete` (auto-advance) is only true at the typical length** (16; Amex 15). A 13-digit Visa is
  valid but does not move focus.
- **`CVC_INVALID`** covers a CVC longer than the brand allows, or with non-digits.
- **`formatExpiry(input, previous?)`:** the previous value keeps backspace from getting stuck on the
  slash.

## Environment simulator

- **Hidden and small:** long-press the "Checkout" title, dev builds only. It holds what the brief asks
  for (platform, Apple Pay, Google Pay) plus "Slow server (8 s)" and "Reset demo". The other mock
  controls (next outcome, exact totals) stay as server routes for the tests and `curl`.

## Native

- **iOS:** Swift (`WalletCapabilityImpl`, PassKit `canMakePayments(usingNetworks:capabilities:)`) with
  Objective-C++ glue. The glue imports `React_RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h`
  before `GametimeCheckout-Swift.h`, because the generated Swift header also declares `SceneDelegate`.
  On the iPhone 17 Pro simulator (iOS 26.5) Apple Pay reports `true`: the simulator ships test cards.
- **Android:** Kotlin with `play-services-wallet` 19.4.0 in `ENVIRONMENT_TEST`, and
  `existingPaymentMethodRequired: true` (Google Pay only with a ready wallet). On a `google_apis`
  emulator with no card in Google Wallet that yields `false`, which is expected; the simulator covers
  the rest.
- **Stale CMake cache:** after adding `codegenConfig`, delete `android/app/.cxx` once. The app CMake
  only links the codegen module provider if `codegen/jni` existed when CMake was configured; with a
  stale cache the module is silently missing in JS.
- **A missing native module means "no wallet"** for both platforms, never a crash.

## Testing notes

- **M9 on Android** (drop the authorize response) exercises the server's idempotent replay rather than
  the client's reconcile path: OkHttp transparently retries a POST whose connection dropped, with the
  same `Idempotency-Key`. Results for M9–M14 are in `docs/chaos-results.md`.
