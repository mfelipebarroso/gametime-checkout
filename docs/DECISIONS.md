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
