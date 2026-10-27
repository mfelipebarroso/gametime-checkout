import type { PaymentMethod } from '@shared';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createCheckout } from '../checkout/createCheckout';
import { attachLifecycle } from '../checkout/lifecycle';
import { DevMenu } from '../dev/DevMenu';
import { DEFAULT_OVERRIDES, effectiveEnvironment, type DevOverrides, type Environment } from '../dev/overrides';
import { canChangeQuantity, hasActiveAttempt } from '../domain/checkout.types';
import { eligibleMethods, type Platform as AppPlatform } from '../domain/eligibility';
import { formatMoney } from '../domain/money';
import { consoleSink, createLogger } from '../logger';
import { walletCapability } from '../native';
import type { Capabilities } from '../native/walletCapability';
import { tokenizeCard } from '../payments/card';
import { WalletSheetController } from '../payments/walletSheet';
import { CardForm } from './CardForm';
import { OrderSummary } from './OrderSummary';
import { PaymentMethods } from './PaymentMethods';
import { PaymentStatus } from './PaymentStatus';
import { SuccessView } from './SuccessView';
import { WalletSheet } from './WalletSheet';
import { colors } from './theme';

const DEVICE_PLATFORM: AppPlatform = Platform.OS === 'android' ? 'android' : 'ios';
const NO_CAPABILITIES: Capabilities = { applePayAvailable: false, googlePayReady: false };
const CANCELLED_MESSAGE_MS = 1800;
const logger = createLogger(consoleSink, { platform: DEVICE_PLATFORM });
const now = () => new Date();

export function CheckoutScreen() {
  const [realCapabilities, setRealCapabilities] = useState<Capabilities | null>(null);
  const [overrides, setOverrides] = useState<DevOverrides>(DEFAULT_OVERRIDES);
  const [cardOpen, setCardOpen] = useState(false);
  const [cardResetKey, setCardResetKey] = useState(0);
  const [devMenuOpen, setDevMenuOpen] = useState(false);

  const environment = useMemo(
    () => effectiveEnvironment(DEVICE_PLATFORM, realCapabilities ?? NO_CAPABILITIES, __DEV__ ? overrides : DEFAULT_OVERRIDES),
    [realCapabilities, overrides],
  );
  // The orchestrator checks eligibility at tap time against the latest environment.
  const environmentRef = useRef<Environment>(environment);
  environmentRef.current = environment;

  const [sheets] = useState(() => new WalletSheetController());
  const [orchestrator] = useState(() =>
    createCheckout({
      logger,
      sheets,
      isEligible: (method, quote) => eligibleMethods({ ...environmentRef.current, total: quote.total }).includes(method),
    }),
  );
  const view = useSyncExternalStore(orchestrator.subscribe, orchestrator.getView);
  const { state, order } = view;
  const quote = order.status === 'loaded' ? order.quote : null;

  // Cold start, AppState and deep links all feed the same reconcile().
  useEffect(() => attachLifecycle(orchestrator, { appState: AppState, linking: Linking }), [orchestrator]);

  // Real wallet detection, re-run whenever the app returns to the foreground: the fan may have just
  // added (or removed) a card in Wallet / Google Wallet.
  useEffect(() => {
    const refresh = () =>
      walletCapability.getCapabilities().then(next =>
        setRealCapabilities(prev =>
          prev?.applePayAvailable === next.applePayAvailable && prev?.googlePayReady === next.googlePayReady ? prev : next,
        ),
      );
    refresh();
    const sub = AppState.addEventListener('change', status => {
      if (status === 'active') {
        refresh();
      }
    });
    return () => sub.remove();
  }, []);

  // Eligibility reacts to every new quote (quantity, fees) and to every environment change.
  const methods = useMemo<PaymentMethod[]>(
    () => (quote ? eligibleMethods({ ...environment, total: quote.total }) : []),
    [environment, quote],
  );
  const methodsKey = methods.join(',');
  useEffect(() => {
    if (methodsKey) {
      logger.log('payment_method_eligible', { code: methodsKey, platform: environment.platform, orderVersion: quote?.version });
    }
  }, [methodsKey, environment.platform, quote?.version]);

  // "Payment cancelled." is a short message, then back to the methods.
  useEffect(() => {
    if (state.tag !== 'cancelled') {
      return;
    }
    const timer = setTimeout(() => orchestrator.dismiss(), CANCELLED_MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [state.tag, orchestrator]);

  // Card data never outlives a terminal result.
  useEffect(() => {
    if (state.tag === 'succeeded' || state.tag === 'declined') {
      setCardResetKey(k => k + 1);
    }
  }, [state.tag]);

  const busy = hasActiveAttempt(state) || state.tag === 'succeeded';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.content}
        // Tapping outside an input dismisses the keyboard; the iOS number pad has no return key.
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        // Keeps the focused card field and the Pay button reachable above the iOS keyboard.
        automaticallyAdjustKeyboardInsets>
        <Text
          style={styles.heading}
          accessibilityRole="header"
          // Hidden environment simulator (dev builds only): long-press the title.
          onLongPress={__DEV__ ? () => setDevMenuOpen(true) : undefined}>
          Checkout
        </Text>

        {order.status === 'loading' && <ActivityIndicator style={styles.loader} />}
        {order.status === 'error' && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>We couldn't load your order.</Text>
            <Pressable accessibilityRole="button" onPress={() => orchestrator.refreshOrder()}>
              <Text style={styles.link}>Try again</Text>
            </Pressable>
          </View>
        )}

        {quote && state.tag === 'succeeded' && <SuccessView quote={quote} attemptId={state.attemptId} />}

        {quote && state.tag !== 'succeeded' && (
          <>
            <OrderSummary
              quote={quote}
              quantityLocked={!canChangeQuantity(state)}
              onChangeQuantity={q => orchestrator.changeQuantity(q)}
            />
            <PaymentStatus
              state={state}
              onRetry={() => orchestrator.retry()}
              onAbandon={() => orchestrator.abandon()}
              onCheckAgain={() => orchestrator.checkAgain()}
              onContinueAffirm={() => orchestrator.continueWithAffirm()}
              onChooseAnother={() => orchestrator.chooseAnotherMethod()}
              onDismiss={() => orchestrator.dismiss()}
            />
            <Text style={styles.sectionTitle}>Pay with</Text>
            <PaymentMethods
              methods={methods}
              locked={busy}
              cardOpen={cardOpen}
              onExpress={method => orchestrator.startPayment(method)}
              onToggleCard={() => setCardOpen(open => !open)}
            />
            {cardOpen && (
              <CardForm
                payLabel={`Pay ${formatMoney(quote.total)}`}
                locked={busy || state.tag !== 'ready'}
                resetKey={cardResetKey}
                now={now}
                onSubmit={form => orchestrator.startPayment('card', { cardToken: tokenizeCard(form) })}
              />
            )}
          </>
        )}
      </ScrollView>

      <WalletSheet controller={sheets} />
      {__DEV__ && (
        <DevMenu
          visible={devMenuOpen}
          onClose={() => setDevMenuOpen(false)}
          overrides={overrides}
          onChangeOverrides={setOverrides}
          devicePlatform={DEVICE_PLATFORM}
          realCapabilities={realCapabilities}
          orchestrator={orchestrator}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingBottom: 120, gap: 16 },
  heading: { fontSize: 28, fontWeight: '800', color: colors.text },
  loader: { marginTop: 40 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginTop: 4 },
  errorBox: { backgroundColor: colors.dangerBg, borderRadius: 12, padding: 14, gap: 8 },
  errorText: { color: colors.danger, fontWeight: '600' },
  link: { color: colors.info, fontWeight: '600' },
});
