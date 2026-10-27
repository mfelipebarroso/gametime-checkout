# SPEC — Gametime Checkout

Technical source of truth for the implementation. The tickets cited (ELIG-01 etc.) come from the
original backlog.

---

## 1. Order and money

```ts
type Currency = 'USD';
type Money = { currency: Currency; minorUnits: number }; // integer, cents

type OrderQuote = {
  orderId: string;        // 'order_demo'
  version: number;        // incremented on every total change
  eventName: string;      // 'Bay City Comets vs. Harbor Kings'
  seatInfo: string;       // 'Section 112 · Row F'
  quantity: number;       // 1..4
  unitPrice: Money;       // 4250
  feePerTicket: Money;    // 925
  subtotal: Money;
  fees: Money;
  total: Money;
  status: 'open' | 'paid';
  paidAttemptId?: string;
};
```

With the default values, quantity 1 gives $51.75 (no Affirm) and quantity 2 gives $103.50
(with Affirm). That way the quantity selector crosses the threshold naturally.

For edge cases, the developer menu forces the total to $99.99, $100.00, $100.01 or $150.00 via
`PUT /v1/mock/orders/:id` (§5.7).

Money formatting: a pure function `formatUSD(minor)` that returns `"$103.50"`. Never divide by 100
as a float to do math, only to display.

---

## 2. Eligibility (ELIG-01, NAT-01, NAT-02, ORDER-01)

```ts
type PaymentMethod = 'apple_pay' | 'google_pay' | 'affirm' | 'card';

type EligibilityInput = {
  platform: 'ios' | 'android';       // real or dev menu override
  applePayAvailable: boolean;        // capability result (or override)
  googlePayReady: boolean;
  total: Money;
};

function eligibleMethods(input: EligibilityInput): PaymentMethod[];
// Display order: platform wallet, then affirm, then card.
```

Rules:

- `apple_pay` appears if `platform === 'ios' && applePayAvailable`.
- `google_pay` appears if `platform === 'android' && googlePayReady`.
- `affirm` appears if `total.currency === 'USD' && total.minorUnits > 10000`.
- `card` always appears.
- If the capability fails, times out (3 s) or throws, the value is `false`. That only hides the
  wallet; it never blocks checkout.

**Total change:** eligibility is recomputed on every new quote. If the selected method is no longer
eligible, the selection goes back to none (or to `card` if the form is open). While an attempt is
active, the quantity selector is disabled.

### Test matrix (TEST-01)

| platform | applePay | googlePay | total  | expected                          |
|----------|----------|-----------|--------|-----------------------------------|
| ios      | true     | —         | 15000  | apple_pay, affirm, card           |
| ios      | false    | —         | 15000  | affirm, card                      |
| ios      | true     | true      | 5000   | apple_pay, card (gpay ignored)    |
| android  | —        | true      | 15000  | google_pay, affirm, card          |
| android  | —        | false     | 8000   | card                              |
| android  | true     | true      | 8000   | google_pay, card (apple ignored)  |
| any      | —        | —         | 9999   | no affirm                         |
| any      | —        | —         | 10000  | **no affirm**                     |
| any      | —        | —         | 10001  | with affirm                       |

### Native module `WalletCapability`

- **TS spec** (`app/src/native/NativeWalletCapability.ts`), as a Turbo Module with codegen:
  - `isApplePayAvailable(): Promise<boolean>`
  - `isGooglePayReady(): Promise<boolean>`
- **iOS (Swift):**
  - `isApplePayAvailable` uses `PKPaymentAuthorizationController.canMakePayments(usingNetworks: [.visa, .masterCard, .amex, .discover], capabilities: .threeDSecure)`.
  - Do **not** use the argument-less `canMakePayments()`, because it does not prove a card is
    provisioned.
  - `isGooglePayReady` returns `false`.
- **Android (Kotlin):**
  - `isGooglePayReady` uses `PaymentsClient` (`play-services-wallet`) with `ENVIRONMENT_TEST` and
    `IsReadyToPayRequest.fromJson(...)`, with `apiVersion 2`, type `CARD`, `allowedAuthMethods`
    `["PAN_ONLY","CRYPTOGRAM_3DS"]` and the networks `AMEX, DISCOVER, MASTERCARD, VISA`.
  - Evaluate `existingPaymentMethodRequired: true` and document in the README the behavior observed
    in the TEST environment.
  - `isApplePayAvailable` returns `false`.
- **JS wrapper** (`walletCapability.ts`):
  - Applies a 3 s timeout, a `catch` that returns `false`, and exposes `getCapabilities()`.
  - If the native module does not exist (for example in tests), it uses a fake.
- **Time limit:** if Turbo Module codegen is stuck for more than ~20 min, use a legacy module through
  the interop layer and record the deviation in `DECISIONS.md`.

---

## 3. Card (CARD-01, CARD-02)

### Supported brands

| Brand      | Prefixes (IIN)                    | Lengths      | CVC | Display format      |
|------------|-----------------------------------|--------------|-----|---------------------|
| visa       | 4                                 | 13, 16, 19   | 3   | 4-4-4-4(-3)         |
| mastercard | 51–55, 2221–2720                  | 16           | 3   | 4-4-4-4             |
| amex       | 34, 37                            | 15           | 4   | 4-6-5               |
| discover   | 6011, 644–649, 65                 | 16–19        | 3   | 4-4-4-4(-3)         |

An unknown brand is invalid, with the message "We don't support this card type" (decision D-08).

### Pure functions (`app/src/domain/card.ts`)

```ts
type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'unknown';
type FieldResult = { valid: boolean; complete: boolean; error?: CardErrorCode };

detectBrand(digits: string): CardBrand
digitsOnly(input: string): string
formatCardNumber(input: string): string          // applies spacing per brand
luhnValid(digits: string): boolean
validateNumber(input: string): FieldResult & { brand: CardBrand }
formatExpiry(input: string): string              // see "Expiry rules" below
validateExpiry(input: string, now: Date): FieldResult
validateCvc(input: string, brand: CardBrand): FieldResult
validateCard(form, now): { valid: boolean; fields: {...}; brand }
```

### Expiry rules

- **Format** `MM/YY`, with the slash inserted automatically.
  - If the first digit is 2 to 9, prefix 0: `"4"` becomes `"04/"`.
  - `"1"` waits for the second digit. `"13"` is an invalid month, so the 3 is rejected.
- **Month** 01 to 12. **Year** = 2000 + YY.
- **Valid if:**
  - the year is greater than the current year, or
  - the year equals the current year and the month is greater than or equal to the current month
    (the current month still counts).
- **Invalid if:** the year is greater than the current year + 20.
- **Tests:** `now` is always injected, never `new Date()` inside the function.

### CVC rules

- Digits only.
- Length 4 for amex and 3 for the others.
- If the brand is still unknown, accept up to 4 digits and mark it incomplete.

### Error codes and messages (UI in English)

| Code                | Message                                    |
|---------------------|--------------------------------------------|
| NUMBER_INCOMPLETE   | Your card number is incomplete.            |
| NUMBER_INVALID      | Your card number is invalid.               |
| BRAND_UNSUPPORTED   | We don't support this card type.           |
| EXPIRY_INCOMPLETE   | Your card's expiration date is incomplete. |
| EXPIRY_INVALID_MONTH| Your card's expiration month is invalid.   |
| EXPIRY_PAST         | Your card has expired.                     |
| EXPIRY_TOO_FAR      | Your card's expiration year is invalid.    |
| CVC_INCOMPLETE      | Your card's security code is incomplete.   |

### Form UX

- **Validation** runs on every `onChangeText`, with the field's whole value (covers autofill, which
  pastes everything at once).
- **Errors** show at two moments: on `onBlur` of a field with invalid content, and on all fields when
  trying to submit. They do not show while the user is still typing.
- **Auto-focus:**
  - A complete, valid number moves focus to expiry.
  - A complete, valid expiry moves focus to CVC.
- **Button** `Pay $103.50`:
  - is `disabled` while `!validateCard(...).valid` or while an attempt is active;
  - on `onPress`, revalidates before calling the orchestrator.
- **Field props:**
  - all use `keyboardType="number-pad"`;
  - number: `textContentType="creditCardNumber"` and `autoComplete="cc-number"`;
  - expiry: `autoComplete="cc-exp"` and the matching `textContentType` when the RN version supports
    it (check);
  - CVC: `autoComplete="cc-csc"`.
- **Accessibility:** each field has an `accessibilityLabel`, and the error message is tied to the field
  and announced.
- **Cleanup:** the form is cleared after a terminal result or when the screen unmounts.

### Test cards

| Number              | Brand      | Mock behavior                                  |
|---------------------|------------|------------------------------------------------|
| 4242 4242 4242 4242 | visa       | approved (unless overridden in the dev menu)   |
| 5555 5555 5555 4444 | mastercard | approved                                       |
| 3782 822463 10005   | amex       | approved (4-digit CVC)                         |
| 6011 1111 1111 1117 | discover   | approved                                       |
| 4000 0000 0000 0002 | visa       | **always declined** (`CARD_DECLINED`)          |

**Fake token:** the card adapter generates `tok_test_<brand>_<last4>`, and for forced declines
`tok_test_decline`. Only the token goes to the server; the card number never does.

---

## 4. States

### 4.1 Server attempt status (`shared/`)

```ts
type AttemptStatus =
  | 'awaiting_user'   // created, waiting for token / Affirm return
  | 'processing'      // authorize accepted, result pending
  | 'succeeded'
  | 'declined'
  | 'cancelled';
```

Allowed server transitions (anything else returns 409):

- `awaiting_user` goes to `processing`, `succeeded`, `declined` or `cancelled`.
- `processing` goes to `succeeded` or `declined`.
- `succeeded`, `declined` and `cancelled` are terminal.

### 4.2 Client UI state (`checkout.reducer.ts`)

```ts
type CheckoutState =
  | { tag: 'ready' }
  | { tag: 'creating'; method }
  | { tag: 'awaiting_wallet'; method; attemptId }    // simulated sheet open
  | { tag: 'awaiting_affirm'; attemptId }             // browser open
  | { tag: 'authorizing'; method; attemptId }
  | { tag: 'reconciling'; attemptId?; reason }        // "We're checking your payment status"
  | { tag: 'succeeded'; attemptId }
  | { tag: 'declined'; attemptId; code }
  | { tag: 'cancelled' }                              // short message, back to ready
  | { tag: 'retryable_error'; reason };               // "Try again" reuses the SAME attempt
```

Reducer rules:

- Only `ready` accepts `START_PAYMENT`. That blocks double taps in the reducer itself, on top of the
  disabled button.
- `succeeded` is terminal on screen. There is no transition back to `ready` without changing orders.
- `declined` goes to `ready` via `DISMISS`. The next attempt is **new**, with new keys.
- Actions invalid for the current state are ignored and logged as `invalid_transition`, without
  throwing.

Mapping the GET result to UI state: `succeeded` goes to `succeeded`, `declined` to `declined`,
`cancelled` to `cancelled`, `processing` to `reconciling` (with polling), and `awaiting_user` follows
§6.4.

---

## 5. HTTP contract

- **Base URL:** `http://localhost:4000` on iOS and `http://10.0.2.2:4000` on the Android Emulator.
  It lives in a single file, `app/src/api/config.ts`.
- **Error format:** `{ "error": { "code": string, "message": string, "attempt"?: Attempt } }`.
- **Attempt representation:**

```ts
type Attempt = {
  attemptId: string;            // 'pat_<uuid>'
  clientAttemptId: string;
  orderId: string;
  orderVersion: number;
  amount: Money;
  method: PaymentMethod;
  status: AttemptStatus;
  failureCode?: 'CARD_DECLINED' | 'INSUFFICIENT_FUNDS' | 'AFFIRM_DECLINED' | 'QUOTE_STALE';
  createdAt: string; updatedAt: string;
};
```

### 5.1 `GET /v1/orders/:orderId` → `200 OrderQuote`

### 5.2 `PUT /v1/orders/:orderId` → `200 OrderQuote`

- Body: `{ "quantity": 1..4 }`.
- Increments `version` and recomputes the total.
- Responds `409 ORDER_ALREADY_PAID` if the order is already paid.
- When the version changes, cancels the order's `awaiting_user` attempts.

### 5.3 `POST /v1/payment-attempts`

- Header **`Idempotency-Key: <clientAttemptId>`** (required).
- Body:

```json
{ "clientAttemptId": "uuid", "order": { "id": "order_demo", "version": 3 },
  "amount": { "currency": "USD", "minorUnits": 10350 }, "method": "affirm" }
```

| Case | Response |
|---|---|
| created | `201 Attempt` (`awaiting_user`) |
| same key + same body | `200` current Attempt + header `Idempotent-Replayed: true` |
| same key + different body | `409 IDEMPOTENCY_KEY_REUSED` |
| version or amount differs from the current order | `409 QUOTE_STALE` (body carries the current quote in `error.quote`) |
| order paid | `409 ORDER_ALREADY_PAID` |
| another attempt for the order in `processing` | `409 ATTEMPT_IN_PROGRESS` (`error.attempt` = the existing one) |
| `affirm` with total ≤ 10000 | `422 METHOD_NOT_ELIGIBLE` |
| invalid body / missing header | `422 VALIDATION_ERROR` / `400 IDEMPOTENCY_KEY_REQUIRED` |

When a new attempt is created for the order, its other `awaiting_user` attempts are cancelled,
because none of them was authorized.

### 5.4 `POST /v1/payment-attempts/:attemptId/authorize`

- Header **`Idempotency-Key: <authorizeKey>`**, generated once per attempt and persisted.
- Body: `{ "sourceToken": "tok_test_visa_4242" }`.
- Runs in a transaction:
  1. Validates the key: a replay returns the stored response; a different hash returns `409`.
  2. Reloads the attempt. If it is not `awaiting_user`, returns `409 ATTEMPT_NOT_AUTHORIZABLE` with
     `error.attempt` (the client reconciles with it).
  3. Revalidates the order version. If it changed, marks the attempt `cancelled` with
     `failureCode QUOTE_STALE` and returns `409 QUOTE_STALE`.
  4. Inserts a row into `authorizations`. `UNIQUE(attempt_id)` is the final guarantee of one
     authorization per attempt.
  5. Applies the mock processor result (§5.7). If `succeeded`, updates the order to `paid`. The
     per-order `UNIQUE` success index prevents double payment.
- Responses:
  - `200 Attempt` with status `succeeded`, `declined` or `processing`. **A decline is 200 with status
    `declined`**, because it is a definitive business result, not a transport error.
  - `404` if the attempt does not exist.

### 5.5 `POST /v1/payment-attempts/:attemptId/cancel`

- No body.
- `awaiting_user` goes to `cancelled` and returns `200`.
- If already terminal, returns `200` with the current state (idempotent by nature).
- If `processing`, returns `409 ATTEMPT_NOT_CANCELLABLE`.

### 5.6 `GET /v1/payment-attempts/:attemptId` → `200 Attempt`

- Before responding, lazily resolves an expired `processing` (§5.7).

### 5.7 Mock routes (only with `MOCK_MODE=1`, otherwise `404`)

- **`POST /v1/mock/scenario`**
  - Body: `{ "nextOutcome": "approve"|"decline"|"processing"|"drop_response", "latencyMs": 0|2000|8000 }`.
  - Applies to the **next** authorize and then reverts to `approve`. Latency persists until changed.
  - `approve`: `succeeded`. If the token is `tok_test_decline`, the result is always `declined`.
  - `decline`: `declined` with `CARD_DECLINED`, or `AFFIRM_DECLINED` when the method is Affirm.
  - `processing`: status `processing` with `resolve_at = now + 5s`. After that, GET returns
    `succeeded`.
  - `drop_response`: records the approved result normally, **commits** and calls
    `req.socket.destroy()` without responding. Simulates "the server charged, the app never knew".
- **`PUT /v1/mock/orders/:orderId`**
  - Body: `{ "totalOverrideMinor": 9999|10000|10001|15000|null }`.
  - Increments the order version.
- **`POST /v1/mock/reset`**: clears attempts, authorizations and keys, and recreates `order_demo`.
- **`GET /mock/affirm/checkout?attemptId=…`**
  - Simple HTML page with the amount and the **Approve** and **Cancel** buttons.
  - The buttons `POST /mock/affirm/checkout/:attemptId/approve|cancel`.
  - The server applies the result to the attempt (`approve` goes through the same path as authorize,
    using the key `affirm:<attemptId>`).
  - Then responds `302 Location: gametime-demo://payment/return?attemptId=…&result=approved|cancelled`.
  - The `return` is fixed on the server; it never comes from the query string (avoids an open
    redirect).
- **`GET /health`** → `200 { ok: true }`.

---

## 6. Client: orchestrator, persistence and reconciliation

### 6.1 Persisted snapshot (AsyncStorage, key `checkout.attempt.v1`)

```ts
type AttemptSnapshot = {
  v: 1;
  clientAttemptId: string;     // also the create Idempotency-Key
  authorizeKey: string;        // generated together, always reused
  attemptId: string | null;    // null until create responds
  orderId: string;
  orderVersion: number;
  amountMinor: number;
  method: PaymentMethod;
  phase: 'creating' | 'awaiting_user' | 'redirected' | 'authorizing';
  startedAt: string;
};
```

- **Forbidden** in the snapshot: card number (PAN), CVC, expiry, `sourceToken` and any form data.
- **On load:** if the JSON is invalid or `v` is not 1, log `snapshot_corrupted`, clear it and move
  on. There is no financial risk, because the server prevents paying twice and, on open, the app
  reloads the order (if it is `paid`, it shows success).

### 6.2 `startPayment(method)` — happy path

1. **Guards:** state is `ready`, the method is eligible, the quote is loaded and there is no pending
   snapshot. If there is a snapshot, reconcile first.
2. **Generate identity:** `clientAttemptId` and `authorizeKey` (UUID v4, via
   `react-native-get-random-values` + `uuid`). **Save the snapshot** with `phase: 'creating'`.
3. **Create:** `POST create`, with a 10 s timeout.
   - On success: store `attemptId` and `phase: 'awaiting_user'` in the snapshot.
   - On network failure: retry with the **same** key up to 2 times. If it keeps failing, go to
     `retryable_error`. "Try again" repeats the create with the same key.
   - On `409 QUOTE_STALE`: reload the order, clear the snapshot and go back to `ready` with the
     message "Your order total changed. Please review."
4. **Present the method:**
   - **Wallet:** open the simulated sheet (`awaiting_wallet`). Confirming produces the token and
     continues to step 5. Cancelling does `POST cancel`, clears the snapshot and goes to `cancelled`.
   - **Card:** the token already came from the form; go straight to step 5.
   - **Affirm:** save `phase: 'redirected'`, call `Linking.openURL(<server>/mock/affirm/checkout?attemptId=…)`
     and go to `awaiting_affirm`. The result arrives via §6.3.
5. **Authorize:** save `phase: 'authorizing'` and `POST authorize` with the `authorizeKey` and a
   15 s timeout.
   - `succeeded` or `declined`: update the UI and **then** clear the snapshot.
   - `processing`: go to `reconciling` (polling).
   - Timeout, network or 5xx: go to `reconciling`. **Never** generate a new key.
   - `409 ATTEMPT_NOT_AUTHORIZABLE`: use `error.attempt` and map it as in §4.2.

### 6.3 Reconciliation triggers

- **`AppState`** changing to `active` with an existing snapshot.
- **Cold start:** when `CheckoutScreen` mounts, load the snapshot. If it exists, reconcile before
  enabling actions.
- **Deep link:** `Linking.addEventListener('url')` while the app is running, and
  `Linking.getInitialURL()` on cold start.
  - Do not trust the `result` parameter; use it only for logging.
  - If the link's `attemptId` differs from the snapshot, log `deeplink_mismatch` and reconcile the
    snapshot.
- All three triggers call the same `reconcile()` function, protected against concurrent execution
  (single-flight).

### 6.4 `reconcile()`

1. If `attemptId` is null (the create may have arrived without its response), repeat `POST create`
   with the same key. The idempotent response returns the `attemptId`.
2. `GET attempt`, with a 1 s, 2 s, 4 s, 8 s and 8 s backoff on error or on `processing`.
   - After 5 tries without a definitive answer, stay in `reconciling` with a **"Check again"**
     button. Never become `declined` by inference.
3. Map the result:
   - **`succeeded`:** show success and clear the snapshot.
   - **`declined`:** show "Your payment was declined. You weren't charged." and clear the snapshot.
   - **`cancelled`:** go back to `ready` and clear the snapshot.
   - **`processing`:** keep polling.
   - **`awaiting_user`**, depending on the phase:
     - phase `redirected` (Affirm): show **"Continue with Affirm"**, which reopens the URL, and
       **"Choose another method"**, which does `POST cancel` and goes back to `ready`;
     - phase `authorizing` with the token still in memory (the app did not die): repeat the authorize
       with the **same** `authorizeKey`;
     - any other case, including cold start (the token is lost): `POST cancel`, then `ready` with the
       message "Your payment wasn't completed. You haven't been charged."
       This is safe because `cancel` only works from `awaiting_user`, atomically.

### 6.5 Status messages (UI)

| State           | Text                                                         |
|-----------------|--------------------------------------------------------------|
| creating / authorizing | Processing your payment…                              |
| awaiting_affirm | Finish in the Affirm window…                                 |
| reconciling     | We're checking your payment status. Don't pay again.         |
| succeeded       | You're in! Your tickets are confirmed.                       |
| declined        | Your payment was declined. You weren't charged.              |
| cancelled       | Payment cancelled.                                           |
| retryable_error | We couldn't reach our servers. Try again.                    |

---

## 7. Payment adapters

```ts
interface PaymentAdapter {
  method: PaymentMethod;
  // Returns a token, 'cancelled', or 'redirected' (Affirm). Never calls the API directly.
  present(ctx: { attemptId: string; amount: Money }): Promise<
    { kind: 'token'; sourceToken: string } | { kind: 'cancelled' } | { kind: 'redirected' }
  >;
}
```

- **Simulated Apple Pay and Google Pay:** a modal that looks close to the native sheet, showing the
  amount, the fake "card" and the confirm and cancel buttons.
  - Apple: "Pay with Face ID" and "Cancel". Google: "Continue" and "Cancel".
  - One tap on the method button calls `startPayment` and opens the sheet. Confirming in the sheet
    finishes everything, without a second "Pay" in checkout.
  - The tokens are `tok_test_applepay` and `tok_test_googlepay`.
- **Affirm:** `present` opens the URL and resolves `redirected`.
- **Card:** `present` returns the token generated from the validated form.

---

## 8. Developer menu (DEV-01)

Reachable through a "Dev" button in the corner of the screen, rendered only under `__DEV__`. Its state
lives in memory (React context); it is not persisted.

| Control | Options | Effect |
|---|---|---|
| Platform | Device · iOS · Android | `platform` in eligibility |
| Apple Pay | Real · Available · Unavailable | capability override |
| Google Pay | Real · Ready · Not ready | capability override |
| Next outcome | Approve · Decline · Processing · Drop response | `POST /v1/mock/scenario` |
| Latency | 0 · 2 s · 8 s | same |
| Order total | Quantity · $99.99 · $100.00 · $100.01 · $150.00 | `PUT /v1/mock/orders/:id` |
| Reset demo | — | `POST /v1/mock/reset` + clear snapshot |

The menu also shows, read-only:

- the **real** capability values;
- the current snapshot, without sensitive fields, since they never exist in it;
- the reducer state.

The default is "Real" for capabilities. With "Platform: iOS" on an Android device, the simulated
Apple Pay sheet appears, which is acceptable because it is pure JS.

---

## 9. Server database (SQLite, file `server/data/dev.db`)

```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL, quantity INTEGER NOT NULL,
  unit_price_minor INTEGER NOT NULL, fee_minor INTEGER NOT NULL,
  total_override_minor INTEGER, status TEXT NOT NULL DEFAULT 'open',
  paid_attempt_id TEXT
);
CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY, client_attempt_id TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id), order_version INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, method TEXT NOT NULL,
  status TEXT NOT NULL, failure_code TEXT, resolve_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_success_per_order ON payment_attempts(order_id) WHERE status = 'succeeded';
CREATE TABLE idempotency_keys (
  key TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('create','authorize')),
  request_hash TEXT NOT NULL, response_status INTEGER NOT NULL, response_body TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (scope, key)
);
CREATE TABLE authorizations (           -- mock processor "ledger"
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts(id),
  source_token_kind TEXT NOT NULL,      -- 'card_visa' | 'apple_pay' ... never the raw token
  outcome TEXT NOT NULL, created_at TEXT NOT NULL
);
```

- `request_hash` is the sha256 of the body's canonical JSON (sorted keys).
- Every create and authorize runs in `db.transaction(...)`. better-sqlite3 is synchronous, which
  serializes operations, and the `UNIQUE` constraints are the final defense.
- Tests use `:memory:` or one temp file per suite. The restart test uses a file.

---

## 10. Logs and minimal telemetry

- **Client:** `log(event, attrs)`.
  - Allowed fields (allowlist): `event`, `method`, `platform`, `attemptId`, `clientAttemptId`,
    `status`, `code`, `phase`, `durationMs`, `orderVersion`.
  - Any other key is dropped. Strings with 12 or more consecutive digits are replaced with
    `[REDACTED]`.
- **Server:** same principle.
  - The log middleware does **not** log the body.
  - It records method, route, status, `attemptId` and the idempotency key prefix (8 characters).
- **Events:** `checkout_viewed`, `payment_method_eligible`, `payment_attempt_created`,
  `provider_presented`, `provider_cancelled`, `payment_authorization_started`,
  `payment_authorization_unknown`, `payment_reconciliation_started`, `payment_succeeded`,
  `payment_declined`, `payment_duplicate_prevented`, `quote_changed`, `snapshot_corrupted`,
  `deeplink_mismatch`, `invalid_transition`.

---

## 11. Automated test matrix (take-home scope)

### App (Jest) — `app/__tests__/`

- `eligibility.test.ts`: the whole §2 matrix.
- `card.test.ts`:
  - valid and invalid Luhn for each brand;
  - detection at range boundaries (2221, 2720, 2719, 2721, 644, 649, 65);
  - lengths;
  - Amex 4-6-5 formatting;
  - expiry in the current month (valid), previous month (invalid), `13/xx`, `00/xx` and +21 years;
  - 3- and 4-digit CVC;
  - autofill (whole string pasted with spaces or hyphens).
- `reducer.test.ts`:
  - all valid transitions;
  - `START_PAYMENT` outside `ready` is ignored;
  - `succeeded` is terminal.
- `orchestrator.test.ts`, with fakes for API, storage, adapters, AppState and Linking:
  - a double `startPayment` produces a single create;
  - the snapshot is saved **before** the first request (check call order);
  - an authorize timeout goes to `reconciling` and **no** second authorize uses a new key;
  - lost create + cold start repeats the create with the same key and recovers the `attemptId`;
  - cold start with `awaiting_user` and phase `authorizing` without a token calls `cancel` and goes
    back to `ready`;
  - a deep link with `result=approved` but GET `declined` results in `declined`;
  - a deep link with a different `attemptId` logs `deeplink_mismatch` and reconciles the snapshot;
  - a corrupted snapshot is cleared without crashing;
  - `QUOTE_STALE` reloads the order.
- `security.test.ts`: after the card flow and failures, no value written to (mock) AsyncStorage and no
  logger output contains `4242424242424242`, the CVC used or `tok_test`.

### Server (Vitest + Supertest) — `server/test/`

- create → authorize → GET approved.
- Card `tok_test_decline` results in `declined` with status 200.
- Same key and same body result in a replay (`Idempotent-Replayed`). Same key and different body
  result in 409.
- **10 parallel authorizes** (`Promise.all`) with the same key result in 1 row in `authorizations`
  and identical responses.
- **10 parallel authorizes with different keys** on the same attempt result in 1 authorization; the
  rest get `409 ATTEMPT_NOT_AUTHORIZABLE`.
- Two approved attempts on the same order: the second gets `ORDER_ALREADY_PAID` or
  `ATTEMPT_IN_PROGRESS`.
- `drop_response`: the socket closes, a later GET shows `succeeded` and a replay with the same key
  does not create a second authorization.
- `processing`: returns `processing` and, after `resolve_at` (injectable clock), GET shows
  `succeeded`.
- `QUOTE_STALE` on create and on authorize, after `PUT /orders`.
- Affirm: create with total 10000 results in 422; with 10001, in 201.
- Restart: close and reopen the DB from the file; GET returns the same attempt.
- Mock routes return 404 without `MOCK_MODE`.
- The server log during the suite does not contain the raw token.
