# CLAUDE.md — Gametime Checkout (take-home)

This file is read in every session. It holds the project's permanent rules.
Details live in:

- `docs/PLAN.md`: execution order, phases, gates and the manual test script.
- `docs/SPEC.md`: API contract, domain model, state machine, card rules and test matrix.
- `docs/DECISIONS.md`: decisions already made (do not reopen without asking).
- `docs/source/` (optional): original architecture and ticket documents.

## What it is

A mobile checkout in **bare React Native + TypeScript** for iOS and Android, plus a **mock server**
in Node + TypeScript + SQLite. It simulates Apple Pay, Google Pay, Affirm and card payments.

- No real money moves.
- Wallet detection is **real**, via native modules. The developer menu can override it.
- Scope is **the take-home only (P0)**. Do not build CI/CD, dashboards, DR, automated E2E tests or
  component tests. They only appear as "next steps" in the README.

## Payment invariants (never violate, not even to make a test pass)

1. **Uncertainty never becomes a new charge.** Timeouts, a dropped network or a lost response lead to
   `reconciling` (a GET lookup), never to a new `authorize` with a new key.
2. **The backend is the authority.** A deep link return, the sheet closing or the app returning to the
   foreground are *signals to reconcile*, not proof of success.
3. **Identity before effect.** The attempt snapshot (`clientAttemptId`, `authorizeKey`, order, version,
   method, phase) is saved to AsyncStorage **before** any request and before opening a sheet/browser.
4. **Nothing sensitive is persisted or logged.** Card number (PAN), CVC, expiry and payment tokens live
   in memory only. AsyncStorage, logs and errors never receive them.
5. **Same logical operation means same key.** A new key is only created for a *new* attempt (for
   example after a definitive decline or a cancellation).
6. **An attempt is authorized at most once, and an order is paid at most once.** The server enforces
   this with transactions and `UNIQUE` constraints, not just client state.
7. **Affirm appears only when `totalMinor > 10000`** (strictly greater). Exactly $100.00 does **not**
   show Affirm.
8. **Card is always available.**
9. **Money is always integer cents** (`minorUnits`). Never use floats for amounts.
10. **The environment simulator exists only under `__DEV__`** in the app, and only with `MOCK_MODE=1`
    on the server.

## Repository layout

```
app/      bare React Native (iOS + Android)
  src/domain/       pure logic: eligibility, card, money, reducer (no RN imports)
  src/checkout/     orchestrator, reconciliation, attempt store
  src/payments/     adapters (applePay, googlePay, affirm, card) + common interface
  src/native/       TS spec + wrapper for the WalletCapability module
  src/api/          paymentApi.ts (the only place that knows URLs)
  src/dev/          developer menu and overrides (__DEV__ only)
  src/ui/           CheckoutScreen and components
  ios/ android/     include the native WalletCapability module and the URL scheme
server/   Node + TS + Express + better-sqlite3
shared/   contract types and enums (imported by app and server)
docs/
```

## Conventions

- TypeScript `strict`. No `any` without a justifying comment.
- `src/domain` does not import `react-native`. Everything there is testable with plain Jest.
- Each payment method's SDK sits behind an interface so tests can use fakes.
- Logs go through the logger with a field **allowlist** (`docs/SPEC.md` §10). Never `console.log`
  form objects, request bodies or tokens.
- **Everything in the repo is in English**: UI text, code, comments, test names, commit messages and
  docs (D-06).
- Small commit at the end of each phase: `phase N: <summary>`.

## Commands

```
cd server && npm run dev          # mock server on :4000 (MOCK_MODE=1)
cd server && npm test             # vitest + supertest
cd app && npm test                # jest (domain + checkout)
cd app && npx tsc --noEmit
cd app && npm run ios             # or: npm run android
```

## How to work

- Follow `docs/PLAN.md` phase by phase. **Do not skip gates.** At the end of each phase, run the phase's
  tests, commit, and report in a few lines what passed, what failed and any deviations from the plan.
- **Ask for confirmation before:** installing anything global (brew, gem, sdkmanager), changing the
  Node/Xcode/JDK version, deleting files outside the repo, or changing any decision in
  `docs/DECISIONS.md`.
- **Native code is frozen (D-13).** Do not change Swift/ObjC++/Kotlin, Gradle, Podfile, `Info.plist`,
  `AndroidManifest.xml` or the Xcode project. Everything from phase 5 on is JS/TS (or server).
- If a native build fails twice for the same reason, stop and report the error with a diagnosis instead
  of blindly trying variations.
- Visual validation (tapping buttons, looking at the screen) depends on the user. Automate what you can
  with `xcrun simctl` and `adb` (launch, terminate, openurl, force-stop) and ask for visual confirmation
  of the rest.
- If a rule in this file conflicts with a ticket in the original documents, this file wins.
