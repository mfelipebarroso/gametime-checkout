import type { PaymentMethod } from '@shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from './theme';

type Props = {
  methods: PaymentMethod[];
  /** Buttons are inert while an attempt is in progress. */
  locked: boolean;
  cardOpen: boolean;
  onExpress: (method: Exclude<PaymentMethod, 'card'>) => void;
  onToggleCard: () => void;
};

/** Express methods start the whole purchase on one tap; "Card" only expands the form. */
export function PaymentMethods({ methods, locked, cardOpen, onExpress, onToggleCard }: Props) {
  return (
    <View style={styles.container}>
      {methods.includes('apple_pay') && (
        <MethodButton label="Pay with Apple Pay" style={styles.apple} textStyle={styles.lightText} locked={locked} onPress={() => onExpress('apple_pay')} />
      )}
      {methods.includes('google_pay') && (
        <MethodButton label="Pay with Google Pay" style={styles.google} textStyle={styles.lightText} locked={locked} onPress={() => onExpress('google_pay')} />
      )}
      {methods.includes('affirm') && (
        <MethodButton label="Pay over time with Affirm" style={styles.affirm} textStyle={styles.lightText} locked={locked} onPress={() => onExpress('affirm')} />
      )}
      <MethodButton
        label={cardOpen ? 'Credit or debit card  ▲' : 'Credit or debit card  ▼'}
        accessibilityLabel="Credit or debit card"
        style={styles.card}
        textStyle={styles.darkText}
        locked={locked}
        expanded={cardOpen}
        onPress={onToggleCard}
      />
    </View>
  );
}

function MethodButton(props: {
  label: string;
  accessibilityLabel?: string;
  style: object;
  textStyle: object;
  locked: boolean;
  expanded?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.locked, expanded: props.expanded }}
      disabled={props.locked}
      onPress={props.onPress}
      style={({ pressed }) => [styles.button, props.style, (pressed || props.locked) && styles.dimmed]}>
      <Text style={[styles.text, props.textStyle]}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10 },
  button: { borderRadius: radius.md, paddingVertical: 16, alignItems: 'center' },
  dimmed: { opacity: 0.55 },
  text: { fontSize: 17, fontWeight: '600' },
  lightText: { color: '#fff' },
  darkText: { color: colors.text },
  apple: { backgroundColor: colors.black },
  google: { backgroundColor: '#1a73e8' },
  affirm: { backgroundColor: colors.affirm },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
});
