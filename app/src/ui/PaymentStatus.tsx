import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { CheckoutState } from '../domain/checkout.types';
import { colors, radius } from './theme';

type Action = { label: string; onPress: () => void; primary?: boolean };

type Props = {
  state: CheckoutState;
  onRetry: () => void;
  onAbandon: () => void;
  onCheckAgain: () => void;
  onContinueAffirm: () => void;
  onChooseAnother: () => void;
  onDismiss: () => void;
};

type Tone = 'info' | 'warning' | 'danger';

/** What the fan sees in each state (SPEC §6.5), including "we don't know yet, we're checking". */
export function PaymentStatus(props: Props) {
  const content = describe(props);
  if (!content) {
    return null;
  }
  const { text, tone, busy, actions } = content;
  return (
    <View style={[styles.box, toneStyles[tone].box]} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <View style={styles.row}>
        {busy && <ActivityIndicator color={toneStyles[tone].text.color} />}
        <Text style={[styles.text, toneStyles[tone].text]}>{text}</Text>
      </View>
      {actions.length > 0 && (
        <View style={styles.actions}>
          {actions.map(a => (
            <Pressable key={a.label} accessibilityRole="button" onPress={a.onPress} style={[styles.action, a.primary && styles.actionPrimary]}>
              <Text style={[styles.actionText, a.primary && styles.actionTextPrimary]}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function describe(p: Props): { text: string; tone: Tone; busy?: boolean; actions: Action[] } | null {
  const { state } = p;
  switch (state.tag) {
    case 'ready':
      if (state.notice === 'quote_changed') {
        return { text: 'Your order total changed. Please review.', tone: 'warning', actions: [{ label: 'OK', onPress: p.onDismiss }] };
      }
      if (state.notice === 'payment_not_completed') {
        return { text: "Your payment wasn't completed. You haven't been charged.", tone: 'warning', actions: [{ label: 'OK', onPress: p.onDismiss }] };
      }
      return null;
    case 'creating':
    case 'authorizing':
      return { text: 'Processing your payment…', tone: 'info', busy: true, actions: [] };
    case 'awaiting_wallet':
      return null; // the sheet is on screen
    case 'awaiting_affirm':
      return { text: 'Finish in the Affirm window…', tone: 'info', busy: true, actions: [] };
    case 'reconciling':
      if (state.reason === 'affirm_pending') {
        return {
          text: "You haven't finished with Affirm yet.",
          tone: 'info',
          actions: [
            { label: 'Continue with Affirm', onPress: p.onContinueAffirm, primary: true },
            { label: 'Choose another method', onPress: p.onChooseAnother },
          ],
        };
      }
      if (state.reason === 'exhausted') {
        return {
          text: "We're still checking your payment status. Don't pay again.",
          tone: 'warning',
          actions: [{ label: 'Check again', onPress: p.onCheckAgain, primary: true }],
        };
      }
      return { text: "We're checking your payment status. Don't pay again.", tone: 'warning', busy: true, actions: [] };
    case 'declined':
      return {
        text: "Your payment was declined. You weren't charged.",
        tone: 'danger',
        actions: [{ label: 'Try another way', onPress: p.onDismiss, primary: true }],
      };
    case 'cancelled':
      return { text: 'Payment cancelled.', tone: 'info', actions: [] };
    case 'retryable_error':
      return {
        text: "We couldn't reach our servers. Try again.",
        tone: 'danger',
        actions: [
          { label: 'Try again', onPress: p.onRetry, primary: true },
          { label: 'Cancel', onPress: p.onAbandon },
        ],
      };
    case 'succeeded':
      return null; // the success view replaces the screen
  }
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.md, padding: 14, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  text: { fontSize: 15, flexShrink: 1, fontWeight: '500' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  actionPrimary: { backgroundColor: colors.text, borderColor: colors.text },
  actionText: { color: colors.text, fontWeight: '600' },
  actionTextPrimary: { color: colors.surface },
});

const toneStyles = {
  info: StyleSheet.create({ box: { backgroundColor: colors.infoBg }, text: { color: colors.info } }),
  warning: StyleSheet.create({ box: { backgroundColor: colors.warningBg }, text: { color: colors.warning } }),
  danger: StyleSheet.create({ box: { backgroundColor: '#fdecea' }, text: { color: colors.danger } }),
};
