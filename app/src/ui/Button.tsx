import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, radius } from './theme';

export type ButtonVariant = 'primary' | 'apple' | 'google' | 'affirm' | 'outline';

type Props = {
  label: string;
  onPress: () => void;
  variant: ButtonVariant;
  disabled?: boolean;
  accessibilityLabel?: string;
  expanded?: boolean;
};

/** Full-width button used for every way to pay. */
export function Button({ label, onPress, variant, disabled = false, accessibilityLabel, expanded }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, expanded }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, variants[variant], (pressed || disabled) && styles.dimmed]}>
      <Text style={[styles.text, variant === 'outline' && styles.darkText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: radius.md, paddingVertical: 16, alignItems: 'center' },
  dimmed: { opacity: 0.5 },
  text: { fontSize: 17, fontWeight: '600', color: colors.onDark },
  darkText: { color: colors.text },
});

const variants = StyleSheet.create({
  primary: { backgroundColor: colors.accent },
  apple: { backgroundColor: colors.apple },
  google: { backgroundColor: colors.google },
  affirm: { backgroundColor: colors.affirm },
  outline: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
});
