import { TEST_TOKENS, type MockScenario, type PaymentMethod } from '../../shared/index';

const PROCESSING_HOLD_MS = 5000;

const DEFAULT_SCENARIO: MockScenario = { nextOutcome: 'approve', latencyMs: 0 };

type ProcessorDecision = {
  outcome: 'approved' | 'declined';
  /** > 0: the attempt stays `processing` until `resolve_at = now + holdMs`. */
  holdMs: number;
  /** `processing` scenario answers right away; latency makes the request wait for the result. */
  respondWhileProcessing: boolean;
  dropResponse: boolean;
};

/** Fake payment processor. `nextOutcome` applies to one authorize, then goes back to `approve`; latency sticks. */
export class MockProcessor {
  private scenario: MockScenario = { ...DEFAULT_SCENARIO };

  getScenario(): MockScenario {
    return { ...this.scenario };
  }

  setScenario(changes: Partial<MockScenario>): void {
    this.scenario = { ...this.scenario, ...changes };
  }

  reset(): void {
    this.scenario = { ...DEFAULT_SCENARIO };
  }

  /** Consumes the scenario, so only call it right before an authorization is recorded. */
  decide(sourceToken: string): ProcessorDecision {
    const { nextOutcome, latencyMs } = this.scenario;
    this.scenario.nextOutcome = 'approve';

    const outcome = sourceToken === TEST_TOKENS.decline || nextOutcome === 'decline' ? 'declined' : 'approved';
    if (nextOutcome === 'processing') {
      return { outcome, holdMs: PROCESSING_HOLD_MS, respondWhileProcessing: true, dropResponse: false };
    }
    return { outcome, holdMs: latencyMs, respondWhileProcessing: false, dropResponse: nextOutcome === 'drop_response' };
  }
}

export function declineCode(method: PaymentMethod): 'CARD_DECLINED' | 'AFFIRM_DECLINED' {
  return method === 'affirm' ? 'AFFIRM_DECLINED' : 'CARD_DECLINED';
}

/** What kind of token paid, for the ledger. The raw token is never stored. */
export function sourceTokenKind(token: string): string {
  switch (token) {
    case TEST_TOKENS.decline:
      return 'card_decline';
    case TEST_TOKENS.applePay:
      return 'apple_pay';
    case TEST_TOKENS.googlePay:
      return 'google_pay';
    case 'affirm':
      return 'affirm';
  }
  const card = /^tok_test_(visa|mastercard|amex|discover)_\d{4}$/.exec(token);
  return card ? `card_${card[1]}` : 'unknown';
}
