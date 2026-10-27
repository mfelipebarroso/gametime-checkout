// Card validation and formatting. Pure functions: `now` is always passed in.

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'unknown';
type SupportedBrand = Exclude<CardBrand, 'unknown'>;

export type CardErrorCode =
  | 'NUMBER_INCOMPLETE'
  | 'NUMBER_INVALID'
  | 'BRAND_UNSUPPORTED'
  | 'EXPIRY_INCOMPLETE'
  | 'EXPIRY_INVALID_MONTH'
  | 'EXPIRY_PAST'
  | 'EXPIRY_TOO_FAR'
  | 'CVC_INCOMPLETE'
  | 'CVC_INVALID';

export const CARD_ERROR_MESSAGES: Record<CardErrorCode, string> = {
  NUMBER_INCOMPLETE: 'Your card number is incomplete.',
  NUMBER_INVALID: 'Your card number is invalid.',
  BRAND_UNSUPPORTED: "We don't support this card type.",
  EXPIRY_INCOMPLETE: "Your card's expiration date is incomplete.",
  EXPIRY_INVALID_MONTH: "Your card's expiration month is invalid.",
  EXPIRY_PAST: 'Your card has expired.',
  EXPIRY_TOO_FAR: "Your card's expiration year is invalid.",
  CVC_INCOMPLETE: "Your card's security code is incomplete.",
  CVC_INVALID: "Your card's security code is invalid.",
};

/**
 * `valid`: the value can be submitted.
 * `complete`: the user has finished typing (used to move focus to the next field).
 */
export type FieldResult = { valid: boolean; complete: boolean; error?: CardErrorCode };

type BrandSpec = {
  /** IIN ranges as [start, end] with the same number of digits. */
  ranges: ReadonlyArray<readonly [string, string]>;
  lengths: readonly number[];
  /** Length at which the number counts as "finished" for auto-focus. */
  completeAt: number;
  cvcLength: number;
  groups: readonly number[];
};

const GROUPS_4 = [4, 4, 4, 4, 3] as const;

const BRANDS: Record<SupportedBrand, BrandSpec> = {
  visa: { ranges: [['4', '4']], lengths: [13, 16, 19], completeAt: 16, cvcLength: 3, groups: GROUPS_4 },
  mastercard: {
    ranges: [
      ['51', '55'],
      ['2221', '2720'],
    ],
    lengths: [16],
    completeAt: 16,
    cvcLength: 3,
    groups: GROUPS_4,
  },
  amex: {
    ranges: [
      ['34', '34'],
      ['37', '37'],
    ],
    lengths: [15],
    completeAt: 15,
    cvcLength: 4,
    groups: [4, 6, 5],
  },
  discover: {
    ranges: [
      ['6011', '6011'],
      ['644', '649'],
      ['65', '65'],
    ],
    lengths: [16, 17, 18, 19],
    completeAt: 16,
    cvcLength: 3,
    groups: GROUPS_4,
  },
};

const BRAND_ORDER: readonly SupportedBrand[] = ['amex', 'visa', 'mastercard', 'discover'];
const MAX_PAN_LENGTH = 19;
const UNKNOWN_CVC_MAX = 4;
const MAX_EXPIRY_YEARS_AHEAD = 20;

export function digitsOnly(input: string): string {
  return input.replace(/\D/g, '');
}

function matchesRange(digits: string, [start, end]: readonly [string, string]): boolean {
  if (digits.length < start.length) {
    return false;
  }
  const prefix = Number(digits.slice(0, start.length));
  return prefix >= Number(start) && prefix <= Number(end);
}

/** Can this prefix still become a number in the range once more digits are typed? */
function couldMatchRange(digits: string, [start, end]: readonly [string, string]): boolean {
  if (digits.length >= start.length) {
    return matchesRange(digits, [start, end]);
  }
  const pad = start.length - digits.length;
  const low = Number(digits) * 10 ** pad;
  const high = (Number(digits) + 1) * 10 ** pad - 1;
  return high >= Number(start) && low <= Number(end);
}

export function detectBrand(digits: string): CardBrand {
  const d = digitsOnly(digits);
  for (const brand of BRAND_ORDER) {
    if (BRANDS[brand].ranges.some(range => matchesRange(d, range))) {
      return brand;
    }
  }
  return 'unknown';
}

function couldBeSupported(digits: string): boolean {
  return BRAND_ORDER.some(brand => BRANDS[brand].ranges.some(range => couldMatchRange(digits, range)));
}

function maxLengthFor(brand: CardBrand): number {
  return brand === 'unknown' ? MAX_PAN_LENGTH : Math.max(...BRANDS[brand].lengths);
}

export function cvcLengthFor(brand: CardBrand): number {
  return brand === 'unknown' ? UNKNOWN_CVC_MAX : BRANDS[brand].cvcLength;
}

export function formatCardNumber(input: string): string {
  const raw = digitsOnly(input);
  const brand = detectBrand(raw);
  const digits = raw.slice(0, maxLengthFor(brand));
  const groups = brand === 'unknown' ? GROUPS_4 : BRANDS[brand].groups;
  const parts: string[] = [];
  let i = 0;
  for (const size of groups) {
    if (i >= digits.length) {
      break;
    }
    parts.push(digits.slice(i, i + size));
    i += size;
  }
  return parts.join(' ');
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function validateNumber(input: string): FieldResult & { brand: CardBrand } {
  const digits = digitsOnly(input);
  const brand = detectBrand(digits);

  if (digits.length === 0) {
    return { valid: false, complete: false, error: 'NUMBER_INCOMPLETE', brand };
  }
  if (brand === 'unknown') {
    // A prefix like "2" or "6" can still become Mastercard or Discover.
    const error = couldBeSupported(digits) ? 'NUMBER_INCOMPLETE' : 'BRAND_UNSUPPORTED';
    return { valid: false, complete: false, error, brand };
  }

  const spec = BRANDS[brand];
  if (digits.length > maxLengthFor(brand)) {
    return { valid: false, complete: true, error: 'NUMBER_INVALID', brand };
  }
  if (!spec.lengths.includes(digits.length)) {
    return { valid: false, complete: false, error: 'NUMBER_INCOMPLETE', brand };
  }
  if (!luhnValid(digits)) {
    return { valid: false, complete: digits.length >= spec.completeAt, error: 'NUMBER_INVALID', brand };
  }
  return { valid: true, complete: digits.length >= spec.completeAt, brand };
}

// ---------- Expiry ----------

const MONTH_YEAR_RE = /^\s*(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})\s*$/;

function isValidMonth(mm: string): boolean {
  const m = Number(mm);
  return mm.length === 2 && m >= 1 && m <= 12;
}

/**
 * Formats the expiry as MM/YY from the field's whole value.
 * - "4" → "04/"; "1" waits; "13" rejects the 3 → "1".
 * - Autofill like "12/2030" or "4/28" is normalized.
 * - `previous` (optional) detects backspace over the slash: "04/" → "04" does not re-add it.
 */
export function formatExpiry(input: string, previous?: string): string {
  const pasted = MONTH_YEAR_RE.exec(input);
  if (pasted) {
    const mm = pasted[1].padStart(2, '0');
    const yy = pasted[2].slice(-2);
    if (isValidMonth(mm)) {
      return `${mm}/${yy}`;
    }
  }

  let digits = digitsOnly(input);
  if (digits.length === 0) {
    return '';
  }
  if (digits[0] >= '2') {
    digits = `0${digits}`;
  }
  digits = digits.slice(0, 4);
  if (digits.length === 1) {
    return digits;
  }
  const mm = digits.slice(0, 2);
  if (!isValidMonth(mm)) {
    return digits[0];
  }
  const yy = digits.slice(2);
  if (yy.length === 0) {
    const deletingSlash = previous !== undefined && previous === `${mm}/` && input === mm;
    return deletingSlash ? mm : `${mm}/`;
  }
  return `${mm}/${yy}`;
}

export function validateExpiry(input: string, now: Date): FieldResult {
  const digits = digitsOnly(input);
  if (digits.length >= 2 && !isValidMonth(digits.slice(0, 2))) {
    return { valid: false, complete: digits.length >= 4, error: 'EXPIRY_INVALID_MONTH' };
  }
  if (digits.length !== 4) {
    return { valid: false, complete: false, error: 'EXPIRY_INCOMPLETE' };
  }
  const month = Number(digits.slice(0, 2));
  const year = 2000 + Number(digits.slice(2));
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (year > currentYear + MAX_EXPIRY_YEARS_AHEAD) {
    return { valid: false, complete: true, error: 'EXPIRY_TOO_FAR' };
  }
  // The current month still counts.
  if (year < currentYear || (year === currentYear && month < currentMonth)) {
    return { valid: false, complete: true, error: 'EXPIRY_PAST' };
  }
  return { valid: true, complete: true };
}

// ---------- CVC ----------

export function formatCvc(input: string, brand: CardBrand): string {
  return digitsOnly(input).slice(0, cvcLengthFor(brand));
}

export function validateCvc(input: string, brand: CardBrand): FieldResult {
  if (/\D/.test(input)) {
    return { valid: false, complete: false, error: 'CVC_INVALID' };
  }
  if (brand === 'unknown') {
    // Without a brand the right length is unknown: accept up to 4 and stay incomplete.
    return { valid: false, complete: false, error: input.length > UNKNOWN_CVC_MAX ? 'CVC_INVALID' : 'CVC_INCOMPLETE' };
  }
  const expected = BRANDS[brand].cvcLength;
  if (input.length < expected) {
    return { valid: false, complete: false, error: 'CVC_INCOMPLETE' };
  }
  if (input.length > expected) {
    return { valid: false, complete: true, error: 'CVC_INVALID' };
  }
  return { valid: true, complete: true };
}

// ---------- Form ----------

export type CardForm = { number: string; expiry: string; cvc: string };

export type CardValidation = {
  valid: boolean;
  brand: CardBrand;
  fields: { number: FieldResult; expiry: FieldResult; cvc: FieldResult };
};

export function validateCard(form: CardForm, now: Date): CardValidation {
  const numberResult = validateNumber(form.number);
  const { brand, ...number } = numberResult;
  const expiry = validateExpiry(form.expiry, now);
  const cvc = validateCvc(form.cvc, brand);
  return {
    valid: number.valid && expiry.valid && cvc.valid,
    brand,
    fields: { number, expiry, cvc },
  };
}

/** Last 4 digits, for the fake token. */
export function last4(input: string): string {
  return digitsOnly(input).slice(-4);
}
