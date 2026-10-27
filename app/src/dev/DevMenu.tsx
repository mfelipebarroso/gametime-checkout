// Hidden environment simulator: forces the platform and wallet availability so every eligibility case can
// be reviewed on one device. Opened by long-pressing the "Checkout" title, dev builds only. Real
// detection stays the default ("Device" / "Real").

import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Platform } from '../domain/eligibility';
import type { Capabilities } from '../native/walletCapability';
import { colors, radius } from '../ui/theme';
import type { DevOverrides } from './overrides';

type Props = {
  visible: boolean;
  onClose: () => void;
  overrides: DevOverrides;
  onChangeOverrides: (next: DevOverrides) => void;
  devicePlatform: Platform;
  realCapabilities: Capabilities | null;
};

export function DevMenu({ visible, onClose, overrides, onChangeOverrides, devicePlatform, realCapabilities: caps }: Props) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Environment simulator</Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.section}>
          <Segmented
            label="Platform"
            options={[
              { label: `Device (${devicePlatform})`, value: 'device' },
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
  section: { backgroundColor: colors.surface, borderRadius: radius.md, padding: 14, gap: 14 },
  label: { color: colors.text, fontWeight: '600' },
  segmentedBlock: { gap: 6 },
  segmented: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  segment: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  segmentSelected: { backgroundColor: colors.text, borderColor: colors.text },
  segmentText: { color: colors.text },
  segmentTextSelected: { color: colors.onDark },
  readonly: { color: colors.muted, fontSize: 13 },
});
