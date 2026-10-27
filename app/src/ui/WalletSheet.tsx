import { useSyncExternalStore } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatMoney } from '../domain/money';
import type { WalletSheetController } from '../payments/walletSheet';
import { colors, radius } from './theme';

/** Simulated native payment sheet (stubbed SDK): amount, a fake card, confirm and cancel. */
export function WalletSheet({ controller }: { controller: WalletSheetController }) {
  const request = useSyncExternalStore(controller.subscribe, controller.getRequest);
  const isApple = request?.method === 'apple_pay';

  return (
    <Modal visible={request !== null} transparent animationType="slide" onRequestClose={() => controller.cancel()}>
      <View style={styles.backdrop}>
        {request && (
          <View style={styles.sheet} accessibilityViewIsModal>
            <View style={styles.header}>
              <Text style={styles.brand}>{isApple ? 'Apple Pay' : 'Google Pay'}</Text>
              <Pressable accessibilityRole="button" onPress={() => controller.cancel()} hitSlop={12}>
                <Text style={styles.cancel}>Cancel</Text>
              </Pressable>
            </View>
            <Row label="Card" value={isApple ? 'Visa •••• 4242 (simulated)' : 'Mastercard •••• 4444 (simulated)'} />
            <Row label="Pay" value="GAMETIME" />
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.total}>{formatMoney(request.amount)}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => controller.confirm()}
              style={[styles.confirm, isApple ? styles.confirmApple : styles.confirmGoogle]}>
              <Text style={styles.confirmText}>{isApple ? 'Pay with Face ID' : 'Continue'}</Text>
            </Pressable>
            <Text style={styles.note}>Stubbed sheet: no real wallet is charged.</Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  brand: { fontSize: 22, fontWeight: '700', color: colors.text },
  cancel: { color: '#1a73e8', fontSize: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingVertical: 10 },
  rowLabel: { color: colors.muted, fontSize: 15 },
  rowValue: { color: colors.text, fontSize: 15 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  totalLabel: { fontSize: 17, fontWeight: '600', color: colors.text },
  total: { fontSize: 17, fontWeight: '700', color: colors.text },
  confirm: { borderRadius: radius.md, paddingVertical: 16, alignItems: 'center' },
  confirmApple: { backgroundColor: colors.black },
  confirmGoogle: { backgroundColor: '#1a73e8' },
  confirmText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  note: { color: colors.muted, fontSize: 12, textAlign: 'center' },
});
