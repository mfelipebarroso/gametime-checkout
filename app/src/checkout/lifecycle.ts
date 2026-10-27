// Wires the three reconciliation triggers to the orchestrator: AppState → active,
// deep links (running and cold start) and the cold start itself. All of them end in the same
// single-flight reconcile().

import type { CheckoutOrchestrator } from './orchestrator';

type Subscription = { remove(): void };

/** The parts of React Native's AppState and Linking used here, so tests can pass fakes. */
export interface AppStateLike {
  addEventListener(type: 'change', listener: (state: string) => void): Subscription;
}

export interface LinkingLike {
  addEventListener(type: 'url', listener: (event: { url: string }) => void): Subscription;
  getInitialURL(): Promise<string | null | undefined>;
}

type Signals = Pick<CheckoutOrchestrator, 'init' | 'onAppActive' | 'handleUrl'>;

// Signals are fire-and-forget; the orchestrator surfaces failures through its own state.
const ignore = () => undefined;

export function attachLifecycle(orchestrator: Signals, deps: { appState: AppStateLike; linking: LinkingLike }): () => void {
  orchestrator.init().catch(ignore);
  const appStateSub = deps.appState.addEventListener('change', state => {
    if (state === 'active') {
      orchestrator.onAppActive().catch(ignore);
    }
  });
  const linkingSub = deps.linking.addEventListener('url', ({ url }) => {
    orchestrator.handleUrl(url).catch(ignore);
  });
  deps.linking
    .getInitialURL()
    .then(url => {
      if (url) {
        orchestrator.handleUrl(url).catch(ignore);
      }
    })
    .catch(ignore);

  return () => {
    appStateSub.remove();
    linkingSub.remove();
  };
}
