# PLAN — take-home execution (P0 scope)

There are 8 phases, each with a gate. Only move on when the gate passes.
The brief's reference budget is about 3 human hours. Phases prioritize
**integrity > eligibility > card > express > interruptions > polish**.

If time gets tight, cut in this order:

1. visual polish of the sheets;
2. "Continue with Affirm" (keep only "Choose another method");
3. refined backoff (use a fixed interval).

**Never cut:** idempotency, snapshot before the request, reconciliation, the `> 10000` rule, card
validation.

---

## Phase 0 — Preflight and scaffold

Tickets: DISC-01.

### Check the environment

Report the versions found and **ask before** installing anything global.

- `node -v` (≥ 20 LTS) and `npm -v`.
- `xcodebuild -version`, `pod --version`, `ruby -v` and `bundle -v`.
- `java -version` (JDK 17), `adb version`, `emulator -list-avds` and `xcrun simctl list devices available`.
- If the AVD lacks a **Google Play** image, warn: the real `isReadyToPay` depends on it.

### Set up the repository

1. `git init` at the root and a `.gitignore` covering node, iOS, Android and `server/data/*.db`.
2. **App:** `npx @react-native-community/cli@latest init GametimeCheckout --directory app --skip-git-init`.
   - Record the generated RN version in `DECISIONS.md`.
   - Configure `tsconfig` in strict mode.
3. **App dependencies:** `@react-native-async-storage/async-storage`, `react-native-get-random-values`
   and `uuid`. Run `cd ios && bundle install && bundle exec pod install`.
4. **Server:** `server/` with `express`, `better-sqlite3`, `zod`, `tsx`, `vitest` and `supertest`.
   - Scripts `dev` (`MOCK_MODE=1 tsx watch src/index.ts`) and `test`.
5. **Shared:** `shared/` with an `index.ts` of types and constants only.
   - The app consumes it via `watchFolders` in `metro.config.js` and a path alias in `tsconfig`/Babel.
   - The server imports it by relative path via `tsx`.
   - If Metro resists, an acceptable alternative: a `sync-shared` script that copies it to
     `app/src/shared` (record in `DECISIONS.md`).
6. **URL scheme `gametime-demo`:**
   - iOS: `CFBundleURLTypes` in `Info.plist`.
   - Android: `intent-filter` with `VIEW`, `BROWSABLE` and `DEFAULT` on `MainActivity`, with
     `launchMode="singleTask"`.
7. **Local HTTP:**
   - iOS: confirm `NSAllowsLocalNetworking` in ATS.
   - Android: confirm cleartext in debug for `10.0.2.2`.

### Gate 0

- [ ] `npm run ios` and `npm run android` open the blank app.
- [ ] `curl localhost:4000/health` returns `{ok:true}`.
- [ ] `xcrun simctl openurl booted gametime-demo://payment/return` and
      `adb shell am start -a android.intent.action.VIEW -d "gametime-demo://payment/return"` open the app.
- [ ] Commit `phase 0: scaffold`.

---

## Phase 1 — Contract and pure domain

Tickets: ARCH-01, ELIG-01, CARD-01, base of ORDER-01.

- `shared/`: `Money`, `PaymentMethod`, `AttemptStatus`, `Attempt`, `OrderQuote`, error codes and
  `AFFIRM_MIN_EXCLUSIVE_MINOR = 10000`.
- `app/src/domain/`:
  - `money.ts` (`formatUSD`);
  - `eligibility.ts`;
  - `card.ts` (all of SPEC §3, with injected `now`);
  - `checkout.types.ts` and `checkout.reducer.ts` (SPEC §4.2).
- Tests: `eligibility.test.ts`, `card.test.ts` and `reducer.test.ts` (SPEC §11).

### Gate 1

- [ ] `cd app && npm test` and `npx tsc --noEmit` pass.
- [ ] No `react-native` import in `src/domain`.
- [ ] Commit.

---

## Phase 2 — Mock server

Tickets: API-01, DATA-01, API-02, IDEM-01, ORDER-01 (server).

- SQL schema (SPEC §9), migration on startup and `order_demo` seed.
- SPEC §5 routes, with `zod` validation, idempotency by `(scope, key)` + `request_hash`, and
  transactions.
- `mockProcessor.ts`: scenario, latency, `drop_response` and `processing` with an injectable clock.
- Mock Affirm HTML page and `302` redirect to the scheme.
- Logger without body.
- Tests: the whole SPEC §11 (server) list.

### Gate 2

- [ ] `cd server && npm test` passes.
- [ ] Must include: 10 parallel authorizes with 1 authorization, `drop_response` + replay with 1
      authorization, and the restart test.
- [ ] Commit.

---

## Phase 3 — Client infrastructure

Tickets: PAY-01, LIFE-01 (logic), SEC-01 (logger).

- `api/config.ts` and `api/paymentApi.ts`:
  - `fetch` + `AbortController`, with 10 s and 15 s timeouts;
  - errors normalized to `{kind: 'network'|'timeout'|'http', status?, code?, attempt?}`.
- `checkout/attemptStore.ts`: v1 snapshot, `load`, `save` and `clear`, tolerant to corruption.
- `checkout/orchestrator.ts`:
  - `startPayment`, `onWalletResult`, `reconcile` (single-flight + backoff), `retry`, `cancel`;
  - injected dependencies (api, store, adapters, clock, logger).
- `checkout/lifecycle.ts`: wires `AppState`, `Linking` (event + `getInitialURL`) and cold start to
  `reconcile()`.
- `logger.ts` with allowlist and redaction (SPEC §10).
- Tests: `orchestrator.test.ts` and `security.test.ts` (SPEC §11).

### Gate 3

- [ ] All app tests pass.
- [ ] The "snapshot before request" ordering test exists and passes.
- [ ] Commit.

---

## Phase 4 — Native module `WalletCapability`

Tickets: NAT-01, NAT-02.

- Turbo Module spec in `app/src/native/NativeWalletCapability.ts` and codegen configured in
  `package.json`.
- **iOS:** Swift + the Objective-C++ glue the Turbo Module requires, with
  `canMakePayments(usingNetworks:capabilities:)`.
- **Android:** Kotlin + `play-services-wallet` with `isReadyToPay` (SPEC §2).
- `walletCapability.ts` wrapper with a 3 s timeout and `false` fallback.
- Record the real value in the `payment_method_eligible` log, to check in the dev menu.
- Time limit: ~20 min stuck on codegen leads to the interop fallback (SPEC §2).

### Gate 4

- [ ] Both builds compile.
- [ ] The real value shows in the dev menu or in the log (the value itself depends on the device and
      does not fail the gate).
- [ ] Commit.

---

## Phase 5 — UI and methods

Tickets: MOB-01, CARD-02, DEV-01, PAY-02, PAY-03, PAY-04, PAY-05, ORDER-01 (UI).

- **`CheckoutScreen`:**
  - `OrderSummary`, with a 1–4 quantity selector (disabled while an attempt is active);
  - `PaymentMethodSelector`, with the wallet and Affirm buttons (one tap starts) and "Card", which
    expands the form;
  - `PaymentStatus`, with the SPEC §6.5 messages;
  - success screen.
- **`CardForm`:** per SPEC §3, full UX.
- **Simulated sheets** for Apple Pay and Google Pay (modal) and **adapters** (SPEC §7).
- **`DevMenu`:** per SPEC §8.
- Wire the reducer to the orchestrator via `useReducer` + context. No loose loading/error booleans.

### Gate 5

- [ ] Typecheck and tests pass.
- [ ] Manual script (below), scenarios M1–M8, **confirmed by the user** on at least one platform.
- [ ] Commit.

---

## Phase 6 — Chaos and interruptions

Tickets: CHAOS-01, LIFE-01 (real validation), SEC-01.

- Run scenarios M9–M14 from the script.
- Automate kill and relaunch:
  - iOS: `xcrun simctl terminate booted <bundleId>` then `xcrun simctl launch booted <bundleId>`;
  - Android: `adb shell am force-stop <pkg>` then `adb shell monkey -p <pkg> 1`.
- **No-duplicate proof:** after each scenario, query SQLite
  (`SELECT count(*) FROM authorizations a JOIN payment_attempts p ON p.id=a.attempt_id WHERE p.order_id='order_demo'`).
  The result must be ≤ 1 per paid order.
- **Security sweep:**
  - `grep -rn "4242424242424242\|tok_test" server/logs app/src --include=*.ts`, excluding tests and
    fixtures;
  - AsyncStorage dump via the dev menu, with no sensitive fields.
- Record the results in a README table (scenario → result → authorizations).

### Gate 6

- [ ] All critical scenarios (M9–M12) with 0 duplicate charges and no invented success or decline.
- [ ] Commit.

---

## Phase 7 — README and final review

Tickets: DOC-01, REL-01.

### Root README.md

1. What it is and what was implemented.
2. Requirements and tested versions (Node, RN, Xcode, JDK, simulators used).
3. Quick start: server, iOS and Android, in under 5 minutes.
4. How eligibility works: native APIs, the `> $100` rule, fallback.
5. Dev menu: how to open it and what each control does.
6. API: routes, request and response examples, error codes.
7. Idempotency and reconciliation: the design in one paragraph, plus the Mermaid state diagram.
8. Verification script: scenarios M1–M14 summarized.
9. Chaos test results (Phase 6).
10. Honest limitations:
    - simulated sheets;
    - `isReadyToPay` behavior in the TEST environment;
    - platforms and versions actually tested;
    - no 3DS, no real PSP.
11. Next steps, out of scope: E2E (Maestro/Detox), component tests, CI, OTel telemetry,
    feature flags/kill switch, Postgres, DR.

### Gate 7

All final checklist items checked, tests green, README checked against the code, and the commit
`phase 7: docs and review`.

---

## Manual verification script

Run **Reset demo** before each scenario. The "Auth" column is the number of rows in
`authorizations` at the end.

| #  | Scenario | Steps | Expected | Auth |
|----|---------|--------|----------|------|
| M1 | iOS eligibility | Dev: iOS, Apple Pay Available, qty 2 | Apple Pay, Affirm, Card | 0 |
| M2 | No wallet | Dev: Apple Pay Unavailable | Affirm, Card | 0 |
| M3 | Threshold | Total $100.00, then $100.01, then $99.99 | Affirm only at $100.01, without restarting the screen | 0 |
| M4 | Invalid card | 4242…4241, then 12/20, then CVC "1" | Errors on blur, button disabled | 0 |
| M5 | Card OK | 4242…4242, future expiry, 123, Pay | Success | 1 |
| M6 | Decline | 4000 0000 0000 0002, Pay; then Dismiss and 4242 | Declined; the 2nd attempt approves | 1 |
| M7 | Express | Tap Apple/Google Pay, confirm in the sheet | Success without a 2nd "Pay" | 1 |
| M8 | Cancel wallet | Tap, then Cancel in the sheet | "Payment cancelled", back to methods | 0 |
| M9 | Lost response | Dev: Drop response; pay by card | "Checking…" then success via GET | 1 |
| M10 | Kill during authorize | Latency 8 s; Pay; kill; relaunch | On open, reconciles and shows success | 1 |
| M11 | Kill with sheet open | Open the sheet; kill; relaunch | "Payment wasn't completed. You haven't been charged." | 0 |
| M12 | Affirm + background | Affirm; Approve in the browser; return via link | Success confirmed by GET | 1 |
| M13 | Affirm + cold start | Affirm; kill the app; Approve in the browser | The link cold-starts the app, which reconciles: success | 1 |
| M14 | Total changes | Open Affirm; come back without approving; qty 1 | Affirm disappears and the old attempt is cancelled | 0 |

---

## Final checklist (the brief's 13 criteria)

- [ ] Apple Pay only on iOS with a compatible wallet.
- [ ] Google Pay only on Android with a ready wallet.
- [ ] Affirm only when the total is greater than $100.
- [ ] Card always available.
- [ ] Validation of number, brand, Luhn, expiry and CVC.
- [ ] The card button does not submit invalid data.
- [ ] Express completes the purchase without a second tap.
- [ ] Decline and cancellation are handled distinctly.
- [ ] `AppState`: reconciles on return.
- [ ] Relaunch: recovers the attempt after a kill.
- [ ] Idempotency: retrying does not create another charge.
- [ ] The simulator reproduces environments and outcomes.
- [ ] The README explains running, architecture, tests and limitations.

**Release blockers** (if any of these happens, do not ship):

- a double tap produces 2 authorizations;
- a retry after a lost response produces a 2nd charge;
- relaunch offers "Pay" without reconciling;
- Affirm visible with total ≤ $100;
- a wallet visible with capability `false`;
- card number or CVC in logs or storage;
- a deep link alone marks the purchase as paid.
