/**
 * What a mobile recording may contain, and what it may never contain.
 *
 * The same promise as the browser SDK's `masking.ts`, made with what a phone
 * can actually tell us. Out of the box a recording keeps what a person types
 * into a `TextInput`: that is what makes a replay of a checkout nobody could
 * finish worth watching. `maskAllInputs` and `maskAllTyping` turn that off, and
 * underneath both of them sits a floor no option can lift — a credential, a
 * one-time code, a payment instrument.
 *
 * Where the web and the phone differ is only in how much a field says about
 * itself. The browser has `type`, `autocomplete` and a name attribute a
 * framework wrote; React Native has `secureTextEntry`, `textContentType`,
 * `autoComplete`, `keyboardType`, the accessibility label and the placeholder.
 * Every one of those is read here. What React Native does *not* have is a way
 * for a plain `<TextInput />` with no hints to say what it is — and, exactly as
 * on the web, such a field is recorded. The honest statement of the difference
 * is in the README: mark the field, or turn `maskAllInputs` on.
 */

/**
 * iOS `textContentType` values that name a credential or a payment instrument.
 *
 * `postalCode` is deliberately absent: a post code is an address, not a payment
 * detail, and a masked delivery address is exactly the kind of thing that makes
 * a checkout replay useless. So are `emailAddress` and `telephoneNumber` —
 * ordinary contact details, recorded by default on both SDKs.
 */
const SENSITIVE_CONTENT_TYPES = new Set([
  'password', 'newPassword', 'oneTimeCode',
  'creditCardNumber', 'creditCardSecurityCode', 'creditCardExpiration',
  'creditCardExpirationMonth', 'creditCardExpirationYear',
  'creditCardName', 'creditCardGivenName', 'creditCardMiddleName', 'creditCardFamilyName',
  'creditCardType',
]);

/**
 * `autoComplete` tokens — and the older `autoCompleteType` ones — that do the
 * same.
 *
 * React Native's list is the web's `autocomplete` vocabulary with a few names
 * of its own (`password-new`, `sms-otp`), so both spellings are here. As above,
 * `postal-code`, `email`, `tel` and `username` are not: they are contact
 * details, not credentials.
 */
const SENSITIVE_AUTOCOMPLETE = new Set([
  'password', 'password-new', 'new-password', 'current-password',
  'sms-otp', 'one-time-code',
  'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-day', 'cc-exp-month', 'cc-exp-year',
  'cc-name', 'cc-given-name', 'cc-middle-name', 'cc-family-name', 'cc-type',
]);

/**
 * The one `keyboardType` that is a statement about secrecy.
 *
 * Android's `visible-password` keyboard exists to type a password with
 * auto-correct and suggestion strips turned off; an app asks for it on the
 * "show password" variant of a login field, which is precisely the field
 * `secureTextEntry` stops covering the moment someone taps the eye. Every other
 * keyboard type says something about the characters, not the secret:
 * `numeric` and `number-pad` are as much a quantity as a card number, and
 * masking every number field would take the order quantity and the delivery
 * floor with it.
 */
const SENSITIVE_KEYBOARD = 'visible-password';

/**
 * How a payment field is named when the app set no hints at all.
 *
 * The same pattern the browser SDK uses, for the same reason: deliberately
 * narrow, because every match is a field the customer can never see again, and
 * the boundaries keep `discard`, `scoreboard` and `accounting` out of it.
 */
const PAYMENT_FIELD = new RegExp(
  '(?:credit|debit|payment)[\\s_-]*card'
  + '|card[\\s_-]*(?:number|num|no|nr|code|pin|cvv|cvc|csc)'
  + '|(?:^|[^a-z])cc[\\s_-]*(?:number|num|no|nr|csc|cvv|cvc|exp)'
  + '|(?:^|[^a-z])(?:cvv|cvc|cvn|csc)(?:[^a-z]|$)'
  + '|security[\\s_-]*code'
  + '|(?:^|[^a-z])iban(?:[^a-z]|$)'
  + '|routing[\\s_-]*number'
  + '|sort[\\s_-]*code',
  'i',
);

/** How a credential field is named. Covers the "show password" toggle. */
const CREDENTIAL_FIELD = /pass(?:word|wd|phrase)|(?:^|[^a-z])pwd(?:[^a-z]|$)|(?:^|[^a-z])otp(?:[^a-z]|$)|one[\s_-]*time[\s_-]*code/i;

/**
 * The props a field's purpose is written in, in practice.
 *
 * `testID` is here as well as being the mask marker: a field a developer called
 * `cvv-input` has said what it is, whether or not anyone remembered `ar-mask`.
 */
const NAMING_PROPS = ['placeholder', 'accessibilityLabel', 'aria-label', 'testID', 'nativeID', 'id'];

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Is this `TextInput` one whose value never leaves the device?
 *
 * Decided from the props alone, so the answer is the same wherever it is asked.
 * `secureTextEntry` is checked by the caller as well, because it applies to any
 * view, not only to a field this function was given.
 */
export function isSensitiveField(props: Record<string, unknown>): boolean {
  if (props.secureTextEntry === true) return true;
  if (SENSITIVE_CONTENT_TYPES.has(text(props.textContentType))) return true;
  if (text(props.keyboardType) === SENSITIVE_KEYBOARD) return true;

  // `autoComplete` is one token in React Native, but a hand-written value or a
  // web-shaped one can carry several; checking each costs nothing.
  const autoComplete = `${text(props.autoComplete)} ${text(props.autoCompleteType)}`.toLowerCase();
  for (const token of autoComplete.split(/\s+/)) {
    if (token && SENSITIVE_AUTOCOMPLETE.has(token)) return true;
  }

  for (const name of NAMING_PROPS) {
    const value = text(props[name]);
    if (value && (PAYMENT_FIELD.test(value) || CREDENTIAL_FIELD.test(value))) return true;
  }
  return false;
}

/**
 * Does this value look like a card number?
 *
 * The last line of defence, for the checkout whose field is a bare `TextInput`
 * with no hints on it — which on a phone is the common case, not the exotic
 * one. A card number is 13–19 digits and passes the Luhn check, which one
 * number in ten passes by chance; a masked order number is a smaller loss than
 * a recorded card number. Byte-for-byte the browser SDK's rule, so the two
 * recorders cannot disagree about what a card number is.
 */
export function looksLikeCardNumber(value: string): boolean {
  if (value.length < 13 || value.length > 24 || !/^[0-9][0-9 -]*[0-9]$/.test(value)) return false;
  const digits = value.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** What a `TextInput` currently holds, in the three props it can arrive in. */
export function fieldValue(props: Record<string, unknown>): string {
  const value = props.text ?? props.value ?? props.defaultValue;
  return typeof value === 'string' ? value : '';
}
