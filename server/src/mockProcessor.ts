import type { MockLatencyMs, MockOutcome, PaymentMethod } from '../../shared/index';

export const DECLINE_TOKEN = 'tok_test_decline';
export const PROCESSING_HOLD_MS = 5000;

export type ProcessorDecision = {
  outcome: 'approved' | 'declined';
  /** > 0: the attempt stays `processing` until `resolve_at = now + holdMs`. */
  holdMs: number;
  /** `processing`: respond immediately with `processing`. Latency: the request waits for resolution. */
  respondWhileProcessing: boolean;
  dropResponse: boolean;
};

/**
 * Mock processor (SPEC §5.7). The scenario applies to the next authorize and then reverts to
 * `approve`; latency persists until changed.
 */
export class MockProcessor {
  private nextOutcome: MockOutcome = 'approve';
  private latencyMs: MockLatencyMs = 0;

  setScenario(s: { nextOutcome?: MockOutcome; latencyMs?: MockLatencyMs }): void {
    if (s.nextOutcome) {
      this.nextOutcome = s.nextOutcome;
    }
    if (s.latencyMs !== undefined) {
      this.latencyMs = s.latencyMs;
    }
  }

  getScenario(): { nextOutcome: MockOutcome; latencyMs: MockLatencyMs } {
    return { nextOutcome: this.nextOutcome, latencyMs: this.latencyMs };
  }

  reset(): void {
    this.nextOutcome = 'approve';
    this.latencyMs = 0;
  }

  /** Consumes the scenario. Call only when an authorization is actually about to be recorded. */
  decide(sourceToken: string): ProcessorDecision {
    const scenario = this.nextOutcome;
    this.nextOutcome = 'approve';

    const forcedDecline = sourceToken === DECLINE_TOKEN;
    const outcome = forcedDecline || scenario === 'decline' ? 'declined' : 'approved';
    if (scenario === 'processing') {
      return { outcome, holdMs: PROCESSING_HOLD_MS, respondWhileProcessing: true, dropResponse: false };
    }
    return {
      outcome,
      holdMs: this.latencyMs,
      respondWhileProcessing: false,
      dropResponse: scenario === 'drop_response',
    };
  }
}

export function declineCode(method: PaymentMethod): 'CARD_DECLINED' | 'AFFIRM_DECLINED' {
  return method === 'affirm' ? 'AFFIRM_DECLINED' : 'CARD_DECLINED';
}

/** Token kind for the ledger. Never the raw token. */
export function sourceTokenKind(token: string): string {
  if (token === DECLINE_TOKEN) return 'card_decline';
  if (token === 'tok_test_applepay') return 'apple_pay';
  if (token === 'tok_test_googlepay') return 'google_pay';
  if (token === 'affirm') return 'affirm';
  const card = /^tok_test_(visa|mastercard|amex|discover)_\d{4}$/.exec(token);
  return card ? `card_${card[1]}` : 'unknown';
}
