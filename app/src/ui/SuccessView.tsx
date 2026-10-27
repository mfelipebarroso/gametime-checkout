import type { OrderQuote } from '@shared';
import { StyleSheet, Text, View } from 'react-native';
import { formatMoney } from '../domain/money';
import { colors, radius } from './theme';

export function SuccessView({ quote, attemptId }: { quote: OrderQuote; attemptId: string }) {
  return (
    <View style={styles.card} accessibilityRole="summary" accessibilityLiveRegion="polite">
      <Text style={styles.check}>✓</Text>
      <Text style={styles.title}>You're in! Your tickets are confirmed.</Text>
      <Text style={styles.detail}>
        {quote.quantity} × {quote.eventName} · {formatMoney(quote.total)}
      </Text>
      <Text style={styles.ref}>Payment {attemptId}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.successBg, borderRadius: radius.lg, padding: 24, alignItems: 'center', gap: 8 },
  check: { fontSize: 40, color: colors.accent },
  title: { fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center' },
  detail: { color: colors.text, textAlign: 'center' },
  ref: { color: colors.muted, fontSize: 12 },
});
