import type { OrderQuote } from '@shared';
import { MAX_QUANTITY, MIN_QUANTITY } from '@shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatMoney } from '../domain/money';
import { colors, radius } from './theme';

type Props = {
  quote: OrderQuote;
  quantityLocked: boolean;
  onChangeQuantity: (quantity: number) => void;
};

export function OrderSummary({ quote, quantityLocked, onChangeQuantity }: Props) {
  const canDecrease = !quantityLocked && quote.quantity > MIN_QUANTITY;
  const canIncrease = !quantityLocked && quote.quantity < MAX_QUANTITY;
  return (
    <View style={styles.card}>
      <Text style={styles.event}>{quote.eventName}</Text>
      <Text style={styles.muted}>{quote.seatInfo}</Text>

      <View style={styles.row}>
        <Text style={styles.label}>Tickets</Text>
        <View style={styles.stepper}>
          <StepButton label="−" accessibilityLabel="Remove a ticket" disabled={!canDecrease} onPress={() => onChangeQuantity(quote.quantity - 1)} />
          <Text style={styles.quantity} accessibilityLabel={`${quote.quantity} tickets`}>
            {quote.quantity}
          </Text>
          <StepButton label="+" accessibilityLabel="Add a ticket" disabled={!canIncrease} onPress={() => onChangeQuantity(quote.quantity + 1)} />
        </View>
      </View>

      <Line label="Subtotal" value={formatMoney(quote.subtotal)} />
      <Line label="Fees" value={formatMoney(quote.fees)} />
      <View style={styles.divider} />
      <Line label="Total" value={formatMoney(quote.total)} bold />
    </View>
  );
}

function StepButton(props: { label: string; accessibilityLabel: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.step, props.disabled && styles.stepDisabled]}>
      <Text style={[styles.stepText, props.disabled && styles.stepTextDisabled]}>{props.label}</Text>
    </Pressable>
  );
}

function Line({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, bold && styles.bold]}>{label}</Text>
      <Text style={[styles.value, bold && styles.bold]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: 16, gap: 8 },
  event: { fontSize: 18, fontWeight: '700', color: colors.text },
  muted: { color: colors.muted, marginBottom: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 32 },
  label: { color: colors.text, fontSize: 15 },
  value: { color: colors.text, fontSize: 15, fontVariant: ['tabular-nums'] },
  bold: { fontWeight: '700', fontSize: 17 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 4 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  step: { width: 36, height: 36, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  stepDisabled: { opacity: 0.4 },
  stepText: { fontSize: 20, color: colors.text },
  stepTextDisabled: { color: colors.disabled },
  quantity: { fontSize: 17, fontWeight: '600', minWidth: 16, textAlign: 'center', color: colors.text },
});
