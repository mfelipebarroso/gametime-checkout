// Simulated Apple Pay / Google Pay sheets. The adapter asks the controller for a sheet and waits; the UI
// renders the pending request as a modal and resolves it with a token or a cancel.

import { TEST_TOKENS, type Money } from '@shared';
import type { WalletMethod } from '../domain/checkout.types';
import type { PaymentAdapter, PresentResult } from './types';

export type SheetRequest = { method: WalletMethod; amount: Money };

const TOKENS: Record<WalletMethod, string> = {
  apple_pay: TEST_TOKENS.applePay,
  google_pay: TEST_TOKENS.googlePay,
};

export class WalletSheetController {
  private request: SheetRequest | null = null;
  private resolve: ((result: PresentResult) => void) | null = null;
  private readonly listeners = new Set<() => void>();

  getRequest = (): SheetRequest | null => this.request;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  present(request: SheetRequest): Promise<PresentResult> {
    // A sheet left open by a previous flow counts as cancelled.
    this.finish({ kind: 'cancelled' });
    return new Promise(resolve => {
      this.request = request;
      this.resolve = resolve;
      this.emit();
    });
  }

  /** "Pay with Face ID" / "Continue": the stubbed SDK returns an authorization token. */
  confirm(): void {
    if (this.request) {
      this.finish({ kind: 'token', sourceToken: TOKENS[this.request.method] });
    }
  }

  cancel(): void {
    this.finish({ kind: 'cancelled' });
  }

  private finish(result: PresentResult): void {
    const resolve = this.resolve;
    this.request = null;
    this.resolve = null;
    resolve?.(result);
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach(listener => listener());
  }
}

export function createWalletSheetAdapter(method: WalletMethod, controller: WalletSheetController): PaymentAdapter {
  return {
    method,
    present: ctx => controller.present({ method, amount: ctx.amount }),
  };
}
