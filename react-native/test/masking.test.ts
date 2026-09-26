import { describe, expect, it } from 'vitest';
import { fieldValue, isSensitiveField, looksLikeCardNumber } from '../src/masking.js';

/**
 * The mobile floor: what a `TextInput` may never carry off the device, decided
 * from the props alone.
 *
 * Every rule here has a twin in the browser SDK's `masking.ts`, expressed in
 * the hints React Native gives instead of the attributes HTML gives. The
 * negative cases matter as much as the positive ones: a false positive is a
 * masked delivery address, which is a replay the customer paid for and cannot
 * use.
 */
describe('fields no option can un-mask', () => {
  it('masks a secure field, whatever else it says about itself', () => {
    expect(isSensitiveField({ secureTextEntry: true })).toBe(true);
  });

  it('masks a credential named by iOS textContentType', () => {
    for (const textContentType of ['password', 'newPassword', 'oneTimeCode']) {
      expect(isSensitiveField({ textContentType }), textContentType).toBe(true);
    }
  });

  it('masks every payment textContentType iOS can fill', () => {
    for (const textContentType of [
      'creditCardNumber', 'creditCardSecurityCode', 'creditCardExpiration',
      'creditCardExpirationMonth', 'creditCardExpirationYear', 'creditCardName',
      'creditCardGivenName', 'creditCardFamilyName', 'creditCardType',
    ]) {
      expect(isSensitiveField({ textContentType }), textContentType).toBe(true);
    }
  });

  it('masks a credential or payment autoComplete token, in either spelling', () => {
    for (const autoComplete of [
      'password', 'password-new', 'new-password', 'current-password', 'sms-otp', 'one-time-code',
      'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-name', 'cc-type',
    ]) {
      expect(isSensitiveField({ autoComplete }), autoComplete).toBe(true);
    }
    // The prop React Native called this before 0.66.
    expect(isSensitiveField({ autoCompleteType: 'cc-number' })).toBe(true);
  });

  it("masks Android's password keyboard, which is what a shown password uses", () => {
    expect(isSensitiveField({ keyboardType: 'visible-password' })).toBe(true);
  });

  it('masks a field whose label, placeholder or testID names what it holds', () => {
    for (const props of [
      { placeholder: 'Card number' },
      { placeholder: 'CVV' },
      { accessibilityLabel: 'Security code' },
      { 'aria-label': 'IBAN' },
      { testID: 'cvc-input' },
      { testID: 'checkout-cardNumber' },
      { placeholder: 'Şifre / password' },
      { accessibilityLabel: 'One time code' },
      { nativeID: 'user_pwd' },
    ]) {
      expect(isSensitiveField(props), JSON.stringify(props)).toBe(true);
    }
  });

  it('masks a value shaped like a card number even with no hints at all', () => {
    for (const number of ['4242424242424242', '4242 4242 4242 4242', '378282246310005']) {
      expect(looksLikeCardNumber(number), number).toBe(true);
    }
  });

  /**
   * A post code is an address, not a payment detail; an email address and a
   * phone number are contact details. Masking them would take the whole
   * delivery step of a checkout replay with them, and the browser SDK does not
   * mask them either.
   */
  it('leaves ordinary fields alone, post codes and contact details included', () => {
    for (const props of [
      {},
      { textContentType: 'postalCode' },
      { autoComplete: 'postal-code' },
      { textContentType: 'emailAddress' },
      { autoComplete: 'email' },
      { textContentType: 'telephoneNumber' },
      { autoComplete: 'tel' },
      { autoComplete: 'username' },
      { keyboardType: 'numeric' },
      { keyboardType: 'number-pad' },
      { keyboardType: 'email-address' },
      { placeholder: 'Teslimat adresi' },
      { placeholder: 'Quantity' },
      { testID: 'discard-draft' },
      { testID: 'scoreboard' },
      { accessibilityLabel: 'Accounting period' },
    ]) {
      expect(isSensitiveField(props), JSON.stringify(props)).toBe(false);
    }
  });

  it('leaves values that are not card numbers alone', () => {
    for (const value of ['', '4242', 'hunter2', '4242424242424241', '05321234567', 'Ada Lovelace']) {
      expect(looksLikeCardNumber(value), value).toBe(false);
    }
  });
});

describe('reading a field value', () => {
  it('takes it from whichever of the three props carries it', () => {
    expect(fieldValue({ text: 'a' })).toBe('a');
    expect(fieldValue({ value: 'b' })).toBe('b');
    expect(fieldValue({ defaultValue: 'c' })).toBe('c');
    // `text` is what the native side reports; it wins over the React props.
    expect(fieldValue({ text: 'a', value: 'b' })).toBe('a');
  });

  it('says nothing for a field holding nothing, or something that is not a string', () => {
    expect(fieldValue({})).toBe('');
    expect(fieldValue({ value: 42 })).toBe('');
  });
});
