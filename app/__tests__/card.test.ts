import {
  detectBrand,
  digitsOnly,
  formatCardNumber,
  formatCvc,
  formatExpiry,
  luhnValid,
  validateCard,
  validateCvc,
  validateExpiry,
  validateNumber,
} from '../src/domain/card';

// Pads a prefix with zeros up to `length` and appends the Luhn check digit.
function withLuhn(prefix: string, length: number): string {
  const body = prefix.padEnd(length - 1, '0');
  for (let d = 0; d <= 9; d++) {
    if (luhnValid(body + d)) {
      return body + d;
    }
  }
  throw new Error('unreachable');
}

function breakLuhn(digits: string): string {
  const last = Number(digits[digits.length - 1]);
  return digits.slice(0, -1) + ((last + 1) % 10);
}

const NOW = new Date(2026, 9, 26); // Oct 26, 2026

describe('luhn and brand', () => {
  test.each([
    ['4242424242424242', 'visa'],
    ['4222222222222', 'visa'],
    ['5555555555554444', 'mastercard'],
    ['2223003122003222', 'mastercard'],
    ['378282246310005', 'amex'],
    ['6011111111111117', 'discover'],
    ['4000000000000002', 'visa'],
  ])('%s is %s and passes Luhn', (number, brand) => {
    expect(detectBrand(number)).toBe(brand);
    expect(luhnValid(number)).toBe(true);
    expect(validateNumber(number)).toMatchObject({ valid: true, brand });
  });

  test.each(['4242424242424241', '5555555555554443', '378282246310006', '6011111111111118'])(
    '%s fails Luhn → NUMBER_INVALID',
    number => {
      expect(luhnValid(number)).toBe(false);
      expect(validateNumber(number)).toMatchObject({ valid: false, error: 'NUMBER_INVALID' });
    },
  );

  test.each([
    ['2221', 'mastercard'],
    ['2720', 'mastercard'],
    ['2719', 'mastercard'],
    ['2721', 'unknown'],
    ['2220', 'unknown'],
    ['51', 'mastercard'],
    ['55', 'mastercard'],
    ['56', 'unknown'],
    ['644', 'discover'],
    ['649', 'discover'],
    ['643', 'unknown'],
    ['65', 'discover'],
    ['6011', 'discover'],
    ['6012', 'unknown'],
    ['34', 'amex'],
    ['37', 'amex'],
    ['35', 'unknown'],
  ])('range boundary %s → %s', (prefix, brand) => {
    expect(detectBrand(prefix.padEnd(16, '0'))).toBe(brand);
  });

  test('unknown brand → BRAND_UNSUPPORTED (D-08)', () => {
    expect(validateNumber(withLuhn('3530', 16))).toMatchObject({ valid: false, error: 'BRAND_UNSUPPORTED' });
    expect(validateNumber('1')).toMatchObject({ error: 'BRAND_UNSUPPORTED' });
  });

  test('prefix that can still become a supported brand → incomplete, not unsupported', () => {
    expect(validateNumber('2')).toMatchObject({ error: 'NUMBER_INCOMPLETE' });
    expect(validateNumber('6')).toMatchObject({ error: 'NUMBER_INCOMPLETE' });
    expect(validateNumber('27')).toMatchObject({ error: 'NUMBER_INCOMPLETE' });
  });
});

describe('lengths', () => {
  test.each([
    ['4', [13, 16, 19]],
    ['51', [16]],
    ['34', [15]],
    ['6011', [16, 17, 18, 19]],
    ['65', [16, 17, 18, 19]],
  ])('prefix %s accepts %j', (prefix, lengths) => {
    for (let len = 12; len <= 20; len++) {
      const result = validateNumber(withLuhn(prefix, len));
      expect(result.valid).toBe(lengths.includes(len));
    }
  });

  test('13-digit visa is valid but not "complete" (does not advance focus)', () => {
    expect(validateNumber('4222222222222')).toMatchObject({ valid: true, complete: false });
    expect(validateNumber('4242424242424242')).toMatchObject({ valid: true, complete: true });
  });

  test('empty and partial → NUMBER_INCOMPLETE', () => {
    expect(validateNumber('')).toMatchObject({ valid: false, error: 'NUMBER_INCOMPLETE' });
    expect(validateNumber('4242 4242')).toMatchObject({ valid: false, error: 'NUMBER_INCOMPLETE' });
  });

  test('too long → NUMBER_INVALID', () => {
    expect(validateNumber(withLuhn('51', 17))).toMatchObject({ valid: false, error: 'NUMBER_INVALID' });
  });
});

describe('formatCardNumber', () => {
  test('amex 4-6-5', () => {
    expect(formatCardNumber('378282246310005')).toBe('3782 822463 10005');
  });
  test('visa 4-4-4-4 and 19 digits 4-4-4-4-3', () => {
    expect(formatCardNumber('4242424242424242')).toBe('4242 4242 4242 4242');
    expect(formatCardNumber(withLuhn('4', 19))).toMatch(/^\d{4} \d{4} \d{4} \d{4} \d{3}$/);
  });
  test('truncates at the brand maximum', () => {
    expect(formatCardNumber('37828224631000599')).toBe('3782 822463 10005');
    expect(formatCardNumber('55555555555544449')).toBe('5555 5555 5555 4444');
  });
  test('partial', () => {
    expect(formatCardNumber('42424')).toBe('4242 4');
    expect(formatCardNumber('')).toBe('');
  });
});

describe('autofill (whole string pasted)', () => {
  test.each(['4242 4242 4242 4242', '4242-4242-4242-4242', ' 4242424242424242 '])('number %j', pasted => {
    expect(digitsOnly(pasted)).toBe('4242424242424242');
    expect(validateNumber(pasted)).toMatchObject({ valid: true, complete: true, brand: 'visa' });
    expect(formatCardNumber(pasted)).toBe('4242 4242 4242 4242');
  });

  test.each([
    ['12/30', '12/30'],
    ['12/2030', '12/30'],
    ['4/28', '04/28'],
    ['1230', '12/30'],
    ['12 / 30', '12/30'],
  ])('expiry %j → %j', (pasted, expected) => {
    expect(formatExpiry(pasted)).toBe(expected);
  });
});

describe('formatExpiry while typing', () => {
  test.each([
    ['', ''],
    ['4', '04/'],
    ['9', '09/'],
    ['1', '1'],
    ['0', '0'],
    ['12', '12/'],
    ['13', '1'],
    ['00', '0'],
    ['123', '12/3'],
    ['12/34', '12/34'],
    ['12/345', '12/34'],
    ['04/2', '04/2'],
  ])('%j → %j', (input, expected) => {
    expect(formatExpiry(input)).toBe(expected);
  });

  test('backspace over the slash does not get stuck', () => {
    expect(formatExpiry('04', '04/')).toBe('04');
    expect(formatExpiry('0', '04')).toBe('0');
  });
});

describe('validateExpiry (now = Oct 26, 2026)', () => {
  test('current month is valid', () => {
    expect(validateExpiry('10/26', NOW)).toEqual({ valid: true, complete: true });
  });
  test('previous month is invalid', () => {
    expect(validateExpiry('09/26', NOW)).toMatchObject({ valid: false, error: 'EXPIRY_PAST' });
  });
  test('previous year is invalid', () => {
    expect(validateExpiry('12/20', NOW)).toMatchObject({ valid: false, error: 'EXPIRY_PAST' });
  });
  test('next year, any month, is valid', () => {
    expect(validateExpiry('01/27', NOW)).toMatchObject({ valid: true });
  });
  test.each(['13/30', '00/30'])('%s → invalid month', input => {
    expect(validateExpiry(input, NOW)).toMatchObject({ valid: false, error: 'EXPIRY_INVALID_MONTH' });
  });
  test('+20 years is valid, +21 is invalid', () => {
    expect(validateExpiry('12/46', NOW)).toMatchObject({ valid: true });
    expect(validateExpiry('01/47', NOW)).toMatchObject({ valid: false, error: 'EXPIRY_TOO_FAR' });
  });
  test.each(['', '1', '12/', '12/3'])('%j → incomplete', input => {
    expect(validateExpiry(input, NOW)).toMatchObject({ valid: false, complete: false, error: 'EXPIRY_INCOMPLETE' });
  });
  test('uses the injected `now`, not the clock', () => {
    expect(validateExpiry('10/26', new Date(2026, 10, 1))).toMatchObject({ error: 'EXPIRY_PAST' });
  });
});

describe('CVC', () => {
  test('3 digits for visa/mastercard/discover', () => {
    for (const brand of ['visa', 'mastercard', 'discover'] as const) {
      expect(validateCvc('123', brand)).toEqual({ valid: true, complete: true });
      expect(validateCvc('12', brand)).toMatchObject({ valid: false, error: 'CVC_INCOMPLETE' });
      expect(validateCvc('1234', brand)).toMatchObject({ valid: false, error: 'CVC_INVALID' });
    }
  });
  test('4 digits for amex', () => {
    expect(validateCvc('1234', 'amex')).toEqual({ valid: true, complete: true });
    expect(validateCvc('123', 'amex')).toMatchObject({ valid: false, error: 'CVC_INCOMPLETE' });
  });
  test('unknown brand: accepts up to 4 and stays incomplete', () => {
    expect(formatCvc('12345', 'unknown')).toBe('1234');
    expect(validateCvc('1234', 'unknown')).toMatchObject({ valid: false, complete: false });
  });
  test('digits only', () => {
    expect(validateCvc('12a', 'visa')).toMatchObject({ valid: false });
    expect(formatCvc('1a2b3', 'visa')).toBe('123');
  });
});

describe('validateCard', () => {
  test('valid form', () => {
    expect(validateCard({ number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' }, NOW)).toMatchObject({
      valid: true,
      brand: 'visa',
    });
  });
  test('amex requires a 4-digit CVC', () => {
    const form = { number: '3782 822463 10005', expiry: '12/30', cvc: '123' };
    expect(validateCard(form, NOW).valid).toBe(false);
    expect(validateCard({ ...form, cvc: '1234' }, NOW).valid).toBe(true);
  });
  test('any invalid field invalidates the form', () => {
    const ok = { number: '4242424242424242', expiry: '12/30', cvc: '123' };
    expect(validateCard({ ...ok, number: breakLuhn(ok.number) }, NOW).valid).toBe(false);
    expect(validateCard({ ...ok, expiry: '12/20' }, NOW).valid).toBe(false);
    expect(validateCard({ ...ok, cvc: '1' }, NOW).valid).toBe(false);
  });
});
