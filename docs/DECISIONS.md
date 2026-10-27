# DECISIONS

Closed decisions. To change any of them, ask the user first. If something deviates during execution,
add a line under "Deviations" at the end of the file.

| ID | Decision | Reason |
|----|----------|--------|
| D-01 | **Bare React Native + TypeScript** (not Expo) | Direct access to Swift/Kotlin for PassKit and `isReadyToPay`; explicit linking |
| D-02 | **Scope: the take-home only (P0)** | User's choice. P1/production items go to "next steps" in the README |
| D-03 | Server **Node + Express + better-sqlite3** with `MOCK_MODE` | Real HTTP boundary; SQLite gives `UNIQUE` and transactions; synchronous and simple |
| D-04 | Tests: **Jest** in the app (RN template default), **Vitest + Supertest** on the server | Each side uses its stack's native runner |
| D-05 | Turbo Module for `WalletCapability`; fall back to interop if codegen is stuck for more than ~20 min | Current recommended architecture, with a way out so the time budget isn't blown |
| D-06 | **Everything in the repo is in English**: UI text, code, comments, test names, commit messages and docs | American product; the user asked for English across the repo (changed on 2026-10-26, see Deviations) |
| D-07 | A payment decline returns `200` with `status: declined` | It is a definitive business result, not a transport error the client should retry |
| D-08 | An unknown card brand is invalid | Clear test matrix; the mock processor only knows 4 brands |
| D-09 | Demo order: $42.50 + $9.25 fee per ticket; qty 1 = $51.75, qty 2 = $103.50 | Crosses the Affirm threshold naturally; exact edge cases come from the dev menu |
| D-10 | Affirm simulated as a server HTML page, opened in the system browser, returning via `gametime-demo://` | Genuinely exercises background, cold start and deep links |
| D-11 | Apple Pay and Google Pay sheets are JS modals | No merchant ID or PSP; the behavior (express, cancel) is what is being evaluated |
| D-12 | Shared types via Metro `watchFolders`; fall back to a copy script | Avoids duplicating the contract |
| D-13 | **Native code is frozen** after phase 4: no further changes to Swift/ObjC++/Kotlin, Gradle, Podfile, `Info.plist`, `AndroidManifest.xml` or the Xcode project | User's decision (2026-10-26). `isGooglePayReady = false` on the emulator is expected (no card in Google Wallet); the dev menu covers simulation |
| D-14 | **The original brief is the only binding requirement**; SPEC/PLAN/DECISIONS are the implementation plan and can be trimmed where they go beyond it | User's decision (2026-10-26). The native `WalletCapability` module stays because the brief asks that "real detection logic should still exist and be the default" and that Apple Pay require a card provisioned in Wallet, which only PassKit/Play Services can tell |

## Conflicts between the original documents and how they were resolved

| # | Conflict | Resolution |
|---|----------|------------|
| C-1 | Doc 1 uses `AttemptStatus` (with `created`, `authorizing`, `requires_reconciliation`…) and doc 2 uses UI states (`idle`, `validating`…) | **Two separate models**: a lean server status (SPEC §4.1) and a client UI state (SPEC §4.2), with an explicit mapping. "Reconciliation" is a *client* state, not a server one |
| C-2 | When to persist: doc 1 says "before opening wallet/browser"; doc 2 (LIFE-01) says "before the first request" | **Doc 2 wins**, being stronger: the snapshot with `clientAttemptId` is saved before `POST create`, which also covers losing the create response |
| C-3 | One idempotency key per attempt or per operation | **Two keys**: `clientAttemptId` for create and `authorizeKey` for authorize, generated together and persisted. On top of that there is a per-attempt guarantee (`UNIQUE(attempt_id)` in `authorizations`) and a per-order one (unique success index) |
| C-4 | Timebox split: doc 1 uses 45/45/60/30 and doc 2 uses 7 blocks (15/30/30/35/35/25/10) | Follow the PLAN phases, which derive from doc 2. Time is a reference, not a gate |
| C-5 | Doc 1 says the schedule starts the "following Monday" after 10/26/2026, but that date is already a Monday | Irrelevant to the take-home; the sprint schedule is out of scope (D-02) |
| C-6 | Doc 1 marks `TEST-03` and `E2E-01` as P1, and so does doc 2; doc 2's checklist asks for broad "verification" | Out of automated scope; covered by the **manual script M1–M14** and documented as next steps |
| C-7 | Doc 2 (PAY-03) says "record that the attempt was cancelled" with no defined endpoint | Created `POST /:id/cancel` (SPEC §5.5) |
| C-8 | Doc 2 (ORDER-01) requires the server to reject a stale version, but there was no order route | Created `GET/PUT /v1/orders/:id` and the mock total override |
| C-9 | `SLM9BIOE` with no defined technical meaning | Treated as an internal label; creates no requirement |

## Deviations during execution

(date, phase, what changed and why)

### 2026-10-26 — Language (D-06)

- D-06 originally read "UI text in English; docs and commits in Portuguese". At the user's request
  everything in the repo is now English, including CLAUDE.md, SPEC, PLAN and this file. The history of
  phases 0–2 was rewritten locally (no remote existed) so commits and comments are in English too.

### 2026-10-26 — Phase 0

- **Generated versions:** React Native **0.88.0**, React 19.3.0, TypeScript 6.0 (template), Express 5,
  better-sqlite3 13, zod 4. Environment: Node 24.17, Xcode 26.6 (iPhone 17 Pro, iOS 26.5),
  JDK 17.0.21, Ruby 4.0.9 / CocoaPods 1.17 (gems installed locally in `app/vendor/bundle`).
- **AVD `Pixel_RN` uses a `google_apis` image (no Play Store).** The real `isReadyToPay` will likely
  return `false`; the dev menu override covers the rest. To be documented in the README.
- **Shared types:** Metro `watchFolders` + `extraNodeModules`, `babel-plugin-module-resolver`
  (`@shared` alias), tsconfig `paths` and Jest `moduleNameMapper`. No copy script.
- **tsconfig:** no `baseUrl` (deprecated in TS 6); relative `paths`.
- **SPEC reference fix:** §1 cited "§5.6" for `PUT /v1/mock/orders`; the correct section is §5.7
  (fixed in the SPEC).
- **Error format:** gains `quote?: OrderQuote`, used by `QUOTE_STALE` (§5.3), alongside `attempt?`.
- **The `affirm:<attemptId>` key** is stored in `idempotency_keys` with `scope = 'authorize'`
  (the `CHECK` is unchanged).
- **`WalletCapability` fake:** used only in tests/`__DEV__`; without the native module outside of
  that, the result is `false`.

### 2026-10-26 — Phase 1

- **`CVC_INVALID`** ("Your card's security code is invalid.") added to the SPEC §3 codes: covers a CVC
  longer than the brand requires, or with non-digits.
- **Ambiguous number prefix** (e.g. "2", "6", "27") yields `NUMBER_INCOMPLETE`, not
  `BRAND_UNSUPPORTED`, while it can still become a supported brand.
- **Number `complete`** is only `true` at the typical length (16; Amex 15). A 13-digit Visa is `valid`
  but does not advance focus.
- **`formatExpiry(input, previous?)`**: the optional second argument keeps backspace from getting
  stuck on the slash.
- **UI state:** `ready` gains `notice?` (`quote_changed` | `payment_not_completed`);
  `reconciling.reason` includes `affirm_pending` and `exhausted` for the "Continue with Affirm" and
  "Check again" buttons. The `method` for `RETRY` and for `AUTHORIZE_STARTED` (retry) comes in the
  action.
- **The reducer** is pure: `createCheckoutReducer(onInvalid)`; the caller logs `invalid_transition`.

### 2026-10-26 — Phase 2

- **Create replay** returns the *current* state of the attempt, not the stored 201. That is what lets
  the client recover `attemptId` and status after losing the response (§6.4 step 1). Only successful
  creates (201) are stored; errors are not, so a retry re-evaluates.
- **The authorize hash** includes the `attemptId`: reusing a key on another attempt returns
  `409 IDEMPOTENCY_KEY_REUSED`.
- **Mock latency** = `processing` with `resolve_at = now + latency`, and the request waits for the
  resolution. During the wait a GET sees `processing`, so killing the app (M10) ends in success via
  polling, never in "cancellable". After resolution, the stored response for the key is updated to the
  final result.
- **Order version changed** (quantity PUT or override): `awaiting_user` attempts become `cancelled`
  with `failureCode QUOTE_STALE`, and an authorize on them returns `409 QUOTE_STALE` (with `attempt`
  and `quote`), not `ATTEMPT_NOT_AUTHORIZABLE`.
- **Total override:** the quote shows `subtotal = override`, `fees = 0`. A quantity PUT clears the
  override (back to "Quantity" mode).
- **Mock extras:** `GET /v1/mock/scenario`, so the dev menu can read the current scenario. When the
  attempt is no longer `awaiting_user`, the Affirm page shows a "Return to Gametime" link.
- **`sourceToken`** must match `^tok_test_[a-z0-9_]+$`; otherwise `422` (without echoing the value).

### 2026-10-26 — Phase 3

- **State ownership:** the orchestrator owns the reducer state and exposes it as an external store
  (`subscribe`/`getView`, for `useSyncExternalStore`) instead of a component-level `useReducer`.
  The double-tap guard and `START_PAYMENT` then run synchronously against the current state; a
  `useReducer` value read through a ref would lag a render behind.
- **Order loading** is a tagged union (`loading | loaded | error`), not loose booleans.
- **Quantity during an attempt:** locked, except in `reconciling/affirm_pending`. That attempt was
  never authorized and the server cancels it when the version changes, which is what M14 requires.
- **Server `cancelled`** (not `QUOTE_STALE`) maps to the `cancelled` UI state, per the §4.2 mapping
  (§6.4 says "back to ready"; `cancelled` is a short message that is dismissed back to `ready`).
  `cancelled` with `QUOTE_STALE` reloads the order and returns to `ready` with the total-changed notice.
- **Reconcile re-authorizes at most once per run** (same key, token still in memory). If the attempt
  is still `awaiting_user` after that, it is cancelled (atomic, only from `awaiting_user`) and the
  user sees "Your payment wasn't completed." This avoids an authorize ↔ reconcile loop.
- **`409 ATTEMPT_IN_PROGRESS` on create:** the client follows the existing attempt by polling; it
  never authorizes it (it has no key or token for it).
- **`abandon()`** from `retryable_error`: clears the snapshot (and cancels the attempt if its id is
  known). Safe because an `awaiting_user` attempt is never authorized without a token.
- **Extra log events:** `payment_create_rejected`, `deeplink_received`, `storage_error`,
  `order_load_failed`. The reconcile reason is logged in `code` (allowlisted).
- **AsyncStorage v3** keeps `getItem/setItem/removeItem`; the store depends on that minimal interface,
  so tests use an in-memory fake. `react-native-get-random-values` is imported first in `index.js`.

### 2026-10-26 — Phase 4

- **Turbo Module with codegen** worked on both platforms (no interop fallback needed).
  `codegenConfig` in `app/package.json` (`GametimeCheckoutSpecs`, iOS `modulesProvider`
  `WalletCapability → RCTWalletCapability`, Android package `com.gametimecheckout.wallet`).
- **iOS:** Swift (`WalletCapabilityImpl`, PassKit `canMakePayments(usingNetworks:capabilities:)`) +
  Objective-C++ glue (`RCTWalletCapability.mm`). The glue imports
  `React_RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h` before `GametimeCheckout-Swift.h`,
  because the generated Swift header also declares `SceneDelegate`. Observed on the iPhone 17 Pro
  simulator (iOS 26.5): `isApplePayAvailable = true` (the simulator ships test cards in Wallet).
- **Android:** Kotlin + `play-services-wallet:19.4.0`, `ENVIRONMENT_TEST`. After adding
  `codegenConfig`, `android/app/.cxx` must be deleted once: the app CMake only links the app codegen
  (`GametimeCheckoutSpecs_ModuleProvider`) if `codegen/jni` existed when CMake was configured; with a
  stale cache the module is silently missing in JS.
- **`existingPaymentMethodRequired` in TEST** (AVD `Pixel_RN`, `google_apis`, no Play Store, no card
  in Google Wallet): `true` → `isReadyToPay = false`; `false` → `true`. Kept `true`, which matches
  "Google Pay only with a ready wallet". The native side logs the result under the `WalletCapability`
  logcat tag (no sensitive data).
- **Missing native module** → `false` for both wallets (`unavailableWalletSource`), with no
  dev-only fake: the dev menu overrides cover simulation.

### 2026-10-26 — Phase 5

- **Environment simulator is hidden and lean** (user's decision): long-press the "Checkout" title
  (dev builds only). It holds only what the brief asks for (Platform; Apple Pay real / card
  provisioned / no cards; Google Pay real / set up / not set up) plus "Slow server (8 s)" to kill the
  app mid-payment and "Reset demo". The SPEC §8 controls for next outcome, exact order totals and the
  state/snapshot dump were dropped from the UI; the server keeps those mock routes for automated tests
  and curl.
- **Card form:** Pay stays disabled until the card is valid (brief: "must not allow submission"), so
  errors show on blur only; the "show all errors on submit" path from SPEC §3 only runs as a guard
  inside `onPress`.
