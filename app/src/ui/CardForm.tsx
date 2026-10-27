// Card form. Validation runs on every change against the field's whole value, so autofill (which fills
// everything at once) is covered. Errors show on blur, never mid-typing; focus moves on when a field is
// complete and valid; Pay stays disabled until the whole card is valid.

import { useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import {
  CARD_ERROR_MESSAGES,
  cvcLengthFor,
  formatCardNumber,
  formatCvc,
  formatExpiry,
  validateCard,
  validateExpiry,
  validateNumber,
  type CardBrand,
  type CardForm as CardFormValues,
  type FieldResult,
} from '../domain/card';
import { Button } from './Button';
import { colors, radius } from './theme';

type Field = keyof CardFormValues;
type TextInputHandle = React.ComponentRef<typeof TextInput>;

type Props = {
  payLabel: string;
  /** An attempt is in progress: the form stays visible but cannot submit. */
  locked: boolean;
  /** Changes after a terminal result; the form clears itself (nothing card-related outlives the attempt). */
  resetKey: number;
  now: () => Date;
  onSubmit: (form: CardFormValues) => void;
};

const EMPTY: CardFormValues = { number: '', expiry: '', cvc: '' };
const UNTOUCHED: Record<Field, boolean> = { number: false, expiry: false, cvc: false };

const BRAND_LABEL: Record<CardBrand, string> = {
  visa: 'VISA',
  mastercard: 'Mastercard',
  amex: 'AMEX',
  discover: 'Discover',
  unknown: '',
};

export function CardForm({ payLabel, locked, resetKey, now, onSubmit }: Props) {
  const [form, setForm] = useState<CardFormValues>(EMPTY);
  const [touched, setTouched] = useState(UNTOUCHED);
  const expiryRef = useRef<TextInputHandle>(null);
  const cvcRef = useRef<TextInputHandle>(null);

  useEffect(() => {
    setForm(EMPTY);
    setTouched(UNTOUCHED);
  }, [resetKey]);

  const validation = validateCard(form, now());
  const brand = validation.brand;

  const errorFor = (field: Field): string | undefined => {
    const result: FieldResult = validation.fields[field];
    if (!touched[field] || form[field].length === 0 || result.valid || !result.error) {
      return undefined;
    }
    return CARD_ERROR_MESSAGES[result.error];
  };

  const blur = (field: Field) => () => setTouched(t => ({ ...t, [field]: true }));

  const onChangeNumber = (text: string) => {
    const number = formatCardNumber(text);
    setForm(f => ({ ...f, number }));
    const result = validateNumber(number);
    if (result.valid && result.complete) {
      setTouched(t => ({ ...t, number: true }));
      expiryRef.current?.focus();
    }
  };

  const onChangeExpiry = (text: string) => {
    const expiry = formatExpiry(text, form.expiry);
    setForm(f => ({ ...f, expiry }));
    if (validateExpiry(expiry, now()).valid) {
      setTouched(t => ({ ...t, expiry: true }));
      cvcRef.current?.focus();
    }
  };

  const onChangeCvc = (text: string) => {
    const cvc = formatCvc(text, brand);
    setForm(f => ({ ...f, cvc }));
    // Card complete and valid: put the keyboard away so the Pay button is in view.
    if (validateCard({ ...form, cvc }, now()).valid) {
      Keyboard.dismiss();
    }
  };

  const submit = () => {
    // Revalidate at press time; never trust the last render.
    const fresh = validateCard(form, now());
    if (!fresh.valid || locked) {
      setTouched({ number: true, expiry: true, cvc: true });
      return;
    }
    onSubmit(form);
  };

  const canSubmit = validation.valid && !locked;

  return (
    <View style={styles.container}>
      <LabeledInput
        label="Card number"
        error={errorFor('number')}
        trailing={BRAND_LABEL[brand]}
        value={form.number}
        onChangeText={onChangeNumber}
        onBlur={blur('number')}
        placeholder="1234 1234 1234 1234"
        textContentType="creditCardNumber"
        autoComplete="cc-number"
        maxLength={23}
        editable={!locked}
        returnKeyType="next"
      />
      <View style={styles.row}>
        <View style={styles.half}>
          <LabeledInput
            inputRef={expiryRef}
            label="Expiration (MM/YY)"
            error={errorFor('expiry')}
            value={form.expiry}
            onChangeText={onChangeExpiry}
            onBlur={blur('expiry')}
            placeholder="MM/YY"
            textContentType="creditCardExpiration"
            autoComplete="cc-exp"
            maxLength={5}
            editable={!locked}
          />
        </View>
        <View style={styles.half}>
          <LabeledInput
            inputRef={cvcRef}
            label={brand === 'amex' ? 'CVC (4 digits)' : 'CVC'}
            error={errorFor('cvc')}
            value={form.cvc}
            onChangeText={onChangeCvc}
            onBlur={blur('cvc')}
            placeholder={brand === 'amex' ? '1234' : '123'}
            textContentType="creditCardSecurityCode"
            autoComplete="cc-csc"
            maxLength={cvcLengthFor(brand)}
            secureTextEntry
            editable={!locked}
          />
        </View>
      </View>

      <Button label={payLabel} variant="primary" disabled={!canSubmit} onPress={submit} />
    </View>
  );
}

type LabeledInputProps = TextInputProps & {
  label: string;
  error?: string;
  trailing?: string;
  inputRef?: React.Ref<TextInputHandle>;
};

function LabeledInput({ label, error, trailing, inputRef, ...input }: LabeledInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputBox, error ? styles.inputError : null]}>
        <TextInput
          ref={inputRef}
          {...input}
          keyboardType="number-pad"
          autoCorrect={false}
          style={styles.input}
          placeholderTextColor={colors.disabled}
          accessibilityLabel={label}
          // The error is part of the field's description, so screen readers read it with the field.
          accessibilityHint={error}
        />
        {trailing ? <Text style={styles.brand}>{trailing}</Text> : null}
      </View>
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  row: { flexDirection: 'row', gap: 12 },
  half: { flex: 1 },
  field: { gap: 6 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  inputBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
  },
  inputError: { borderColor: colors.danger },
  input: { flex: 1, fontSize: 17, paddingVertical: 12, color: colors.text, fontVariant: ['tabular-nums'] },
  brand: { color: colors.muted, fontWeight: '700', fontSize: 12 },
  error: { color: colors.danger, fontSize: 13 },
});
