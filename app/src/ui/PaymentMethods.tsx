import type { PaymentMethod } from '@shared';
import { StyleSheet, View } from 'react-native';
import { Button, type ButtonVariant } from './Button';

type ExpressMethod = Exclude<PaymentMethod, 'card'>;

const EXPRESS_BUTTONS: Array<{ method: ExpressMethod; label: string; variant: ButtonVariant }> = [
  { method: 'apple_pay', label: 'Pay with Apple Pay', variant: 'apple' },
  { method: 'google_pay', label: 'Pay with Google Pay', variant: 'google' },
  { method: 'affirm', label: 'Pay over time with Affirm', variant: 'affirm' },
];

type Props = {
  methods: PaymentMethod[];
  /** Buttons are inert while an attempt is in progress. */
  locked: boolean;
  cardOpen: boolean;
  onExpress: (method: ExpressMethod) => void;
  onToggleCard: () => void;
};

/** Express methods start the whole purchase on one tap; "Card" only expands the form. */
export function PaymentMethods({ methods, locked, cardOpen, onExpress, onToggleCard }: Props) {
  return (
    <View style={styles.container}>
      {EXPRESS_BUTTONS.filter(b => methods.includes(b.method)).map(b => (
        <Button key={b.method} label={b.label} variant={b.variant} disabled={locked} onPress={() => onExpress(b.method)} />
      ))}
      <Button
        label={`Credit or debit card  ${cardOpen ? '▲' : '▼'}`}
        accessibilityLabel="Credit or debit card"
        variant="outline"
        disabled={locked}
        expanded={cardOpen}
        onPress={onToggleCard}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10 },
});
