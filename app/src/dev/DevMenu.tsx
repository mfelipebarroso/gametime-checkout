// Hidden environment simulator (brief: "a dev menu, hidden settings screen… that forces iOS, Android,
// no provisioned cards"). Opened by long-pressing the "Checkout" title, only under __DEV__. Real
// detection stays the default ("Device" / "Real").

import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import type { MockApi } from '../api/paymentApi';
import type { CheckoutOrchestrator } from '../checkout/orchestrator';
import type { Platform } from '../domain/eligibility';
import type { Capabilities } from '../native/walletCapability';
import { colors, radius } from '../ui/theme';
import type { DevOverrides } from './overrides';

/** Long enough to kill the app while an authorize is in flight. */
const SLOW_SERVER_MS = 8000;

type Props = {
  visible: boolean;
  onClose: () => void;
  overrides: DevOverrides;
  onChangeOverrides: (next: DevOverrides) => void;
  devicePlatform: Platform;
  realCapabilities: Capabilities | null;
  mockApi: MockApi;
  orchestrator: CheckoutOrchestrator;
};

export function DevMenu(props: Props) {
  const { visible, onClose, overrides, onChangeOverrides, mockApi, orchestrator } = props;
  const [slowServer, setSlowServer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }
    mockApi
      .getScenario()
      .then(s => {
        setSlowServer(s.latencyMs > 0);
        setError(null);
      })
      .catch(() => setError('Mock server unreachable'));
  }, [visible, mockApi]);

  const run = (task: () => Promise<unknown>) => {
    task()
      .then(() => setError(null))
      .catch(() => setError('Mock server unreachable'));
  };

  const toggleSlowServer = (on: boolean) =>
    run(async () => {
      const s = await mockApi.setScenario({ latencyMs: on ? SLOW_SERVER_MS : 0 });
      setSlowServer(s.latencyMs > 0);
    });

  const reset = () =>
    run(async () => {
      await mockApi.reset();
      await orchestrator.devReset();
      setSlowServer(false);
    });

  const caps = props.realCapabilities;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Environment simulator</Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Done</Text>
          </Pressable>
        </View>
        {error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.section}>
          <Segmented
            label="Platform"
            options={[
              { label: `Device (${props.devicePlatform})`, value: 'device' },
              { label: 'iOS', value: 'ios' },
              { label: 'Android', value: 'android' },
            ]}
            value={overrides.platform}
            onChange={platform => onChangeOverrides({ ...overrides, platform })}
          />
          <Segmented
            label="Apple Pay"
            options={[
              { label: 'Real', value: 'real' },
              { label: 'Card provisioned', value: 'available' },
              { label: 'No cards', value: 'unavailable' },
            ]}
            value={overrides.applePay}
            onChange={applePay => onChangeOverrides({ ...overrides, applePay })}
          />
          <Segmented
            label="Google Pay"
            options={[
              { label: 'Real', value: 'real' },
              { label: 'Set up', value: 'ready' },
              { label: 'Not set up', value: 'not_ready' },
            ]}
            value={overrides.googlePay}
            onChange={googlePay => onChangeOverrides({ ...overrides, googlePay })}
          />
          <Text style={styles.readonly}>
            Real detection on this device: Apple Pay {caps ? String(caps.applePayAvailable) : '…'} · Google Pay{' '}
            {caps ? String(caps.googlePayReady) : '…'}
          </Text>
        </View>

        <View style={styles.section}>
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={styles.label}>Slow server (8 s)</Text>
              <Text style={styles.readonly}>Time to background or kill the app mid-payment.</Text>
            </View>
            <Switch value={slowServer} onValueChange={toggleSlowServer} accessibilityLabel="Slow server" />
          </View>
          <Pressable accessibilityRole="button" onPress={reset} style={styles.reset}>
            <Text style={styles.resetText}>Reset demo</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Modal>
  );
}

function Segmented<T extends string>(props: {
  label: string;
  options: Array<{ label: string; value: T }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmentedBlock}>
      <Text style={styles.label}>{props.label}</Text>
      <View style={styles.segmented}>
        {props.options.map(o => {
          const selected = o.value === props.value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => props.onChange(o.value)}
              style={[styles.segment, selected && styles.segmentSelected]}>
              <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingTop: 64, gap: 16, backgroundColor: colors.background, flexGrow: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  close: { color: colors.info, fontSize: 16, fontWeight: '600' },
  error: { color: colors.danger },
  section: { backgroundColor: colors.surface, borderRadius: radius.md, padding: 14, gap: 14 },
  label: { color: colors.text, fontWeight: '600' },
  segmentedBlock: { gap: 6 },
  segmented: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  segment: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  segmentSelected: { backgroundColor: colors.text, borderColor: colors.text },
  segmentText: { color: colors.text },
  segmentTextSelected: { color: '#fff' },
  readonly: { color: colors.muted, fontSize: 13 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchText: { flex: 1, gap: 2 },
  reset: { backgroundColor: '#fdecea', borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' },
  resetText: { color: colors.danger, fontWeight: '700' },
});
